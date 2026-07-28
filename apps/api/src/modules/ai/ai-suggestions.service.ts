import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiMode, Prisma } from '@whauto/database';
import {
  AiConversationInHandoffError,
  AiDisabledError,
  aiDebounceJobId,
  AiSuggestionAlreadyHandledError,
  AiSuggestionNotFoundError,
  AiSuggestionStaleError,
  AiSuggestionVersionConflictError,
  ConversationNotFoundError,
  SOCKET_EVENTS,
} from '@whauto/shared';
import type { AiProcessMessageJobData, AiRealtimeEvent } from '@whauto/shared';
import {
  InsufficientCreditsError,
  MAX_CREDITS_PER_AI_RUN,
  WalletClosedError,
  WalletSuspendedError,
} from '@whauto/wallet';
import type { Queue } from 'bullmq';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { WalletService } from '../../wallet/wallet.service';
import { MessagesService } from '../conversations/messages.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { AI_PROCESS_QUEUE } from '../../queues/whatsapp-queues.module';
import { AcceptSuggestionDto, RejectSuggestionDto } from './dto/ai.dto';
import { toSuggestionResponse } from './ai.mapper';
import type { AiSuggestionResponseDto } from './dto/ai.dto';

const ACTIVE_RUN_STATUSES = ['QUEUED', 'RUNNING', 'WAITING_TOOL'] as const;

/** Résolution du mode effectif (identique au worker) : env DISABLED > config > env. */
function resolveEffectiveMode(envMode: AiMode, configMode: AiMode | null): AiMode {
  if (envMode === 'DISABLED') return 'DISABLED';
  return configMode ?? envMode;
}

@Injectable()
export class AiSuggestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly messages: MessagesService,
    private readonly realtime: RealtimeService,
    private readonly audit: OrganizationAuditService,
    private readonly wallet: WalletService,
    @Inject(AI_PROCESS_QUEUE) private readonly aiQueue: Queue<AiProcessMessageJobData>,
  ) {}

  // ---------------------------------------------------------------------- list

  async list(
    tenant: TenantContext,
    conversationId: string,
  ): Promise<{ items: AiSuggestionResponseDto[] }> {
    await this.loadConversation(tenant, conversationId);
    const rows = await this.prisma.aiSuggestion.findMany({
      where: { organizationId: tenant.organizationId, conversationId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return { items: rows.map(toSuggestionResponse) };
  }

  // ------------------------------------------------------------------ generate

  /**
   * Génération manuelle IDEMPOTENTE. Un handoff ouvert ou l'IA désactivée
   * bloquent. Une suggestion PENDING ou un run actif existant est renvoyé tel
   * quel. `forceRegenerate` expire la suggestion et supersède le run actif avant
   * de replanifier — le worker reste l'autorité (triggerMessageId unique).
   */
  async generate(
    tenant: TenantContext,
    conversationId: string,
    forceRegenerate: boolean,
    context: AuditActionContext,
  ): Promise<{ status: string; suggestion: AiSuggestionResponseDto | null }> {
    const conversation = await this.loadConversation(tenant, conversationId);

    await this.assertAiActive(tenant, conversation.shopId);
    await this.assertNoOpenHandoff(conversationId);

    const existingSuggestion = await this.prisma.aiSuggestion.findFirst({
      where: { organizationId: tenant.organizationId, conversationId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    const activeRun = await this.prisma.aiRun.findFirst({
      where: { conversationId, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
    });

    if (!forceRegenerate) {
      if (existingSuggestion) {
        return { status: 'EXISTING_SUGGESTION', suggestion: toSuggestionResponse(existingSuggestion) };
      }
      if (activeRun) {
        return { status: 'RUN_IN_PROGRESS', suggestion: null };
      }
    } else {
      // Expire l'ancienne suggestion, supersède le run actif — jamais de suppression.
      if (existingSuggestion) {
        await this.prisma.aiSuggestion.updateMany({
          where: { id: existingSuggestion.id, status: 'PENDING' },
          data: { status: 'EXPIRED' },
        });
      }
      if (activeRun) {
        // Supersede + libération de la réservation dans la MÊME transaction
        // (groupe 4) — sans quoi les crédits réservés fuiraient jusqu'au sweep.
        await this.prisma.$transaction(async (tx) => {
          const superseded = await tx.aiRun.updateMany({
            where: { id: activeRun.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
            data: { status: 'SUPERSEDED', completedAt: new Date() },
          });
          if (superseded.count === 1) {
            await this.wallet.releaseAiRunReservationInTx(tx, {
              organizationId: tenant.organizationId,
              aiRunId: activeRun.id,
            });
          }
        });
      }
      await this.audit.recordSafe({
        organizationId: tenant.organizationId,
        eventType: 'AI_SUGGESTION_REGENERATED',
        actorUserId: tenant.userId,
        metadata: { conversationId },
        context,
      });
    }

    const trigger = await this.prisma.message.findFirst({
      where: { conversationId, direction: 'INBOUND', senderType: 'CUSTOMER', type: 'TEXT' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, channelId: true },
    });
    if (!trigger) {
      return { status: 'NO_MESSAGE', suggestion: null };
    }

    // triggerMessageId est UNIQUE (invariant validé) : si le dernier message a
    // déjà eu un run (auto-déclenché ou superseded), aucun NOUVEAU run n'est
    // possible pour LUI. On ne publie pas un job voué au no-op ; une vraie
    // nouvelle suggestion exige un nouveau message client.
    const existingRun = await this.prisma.aiRun.findUnique({
      where: { triggerMessageId: trigger.id },
      select: { id: true },
    });
    if (existingRun) {
      return { status: 'NO_NEW_RUN', suggestion: null };
    }

    // Pré-contrôle crédits (NON autoritaire — le worker réserve sous verrou et
    // reste l'autorité finale) : renvoie 409 immédiat pour l'UX, uniquement
    // maintenant qu'un vrai nouveau run serait planifié (jamais de réservation
    // multiple : le pré-contrôle est en lecture seule).
    await this.assertCanReserveCredits(tenant.organizationId);

    await this.enqueue(tenant, conversation.shopId, conversationId, trigger.id, trigger.channelId);
    await this.audit.recordSafe({
      organizationId: tenant.organizationId,
      eventType: 'AI_SUGGESTION_GENERATED',
      actorUserId: tenant.userId,
      metadata: { conversationId },
      context,
    });
    return { status: 'QUEUED', suggestion: null };
  }

  // -------------------------------------------------------------------- accept

  /**
   * Acceptation ATOMIQUE. Réutilise EXACTEMENT le flux d'envoi humain
   * (MessagesService.createOutboundInTx → Message PENDING + outbox → worker) :
   * aucun appel direct à Meta/provider depuis l'IA. Sous verrou de la suggestion
   * (FOR UPDATE) : status PENDING + version attendue + contrôle stale, puis
   * transition conditionnelle qui GATE l'envoi — deux acceptations concurrentes
   * ne créent jamais deux Messages (la seconde → 409 ALREADY_HANDLED).
   */
  async accept(
    tenant: TenantContext,
    conversationId: string,
    suggestionId: string,
    dto: AcceptSuggestionDto,
    context: AuditActionContext,
  ) {
    const conversation = await this.messages.loadSendableConversation(tenant, conversationId);
    this.messages.assertSendable(conversation);

    const suggestion = await this.loadSuggestion(tenant, conversationId, suggestionId);
    if (suggestion.status !== 'PENDING') {
      throw new AiSuggestionAlreadyHandledError();
    }

    const clientMessageId = randomUUID();
    const dispatchId = randomUUID();
    const edited = dto.content.trim() !== suggestion.content.trim();

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM ai_suggestions WHERE id = ${suggestionId} FOR UPDATE`;

      const current = await tx.aiSuggestion.findUniqueOrThrow({
        where: { id: suggestionId },
        select: { status: true, version: true, contextLastMessageId: true },
      });
      if (current.status !== 'PENDING') {
        throw new AiSuggestionAlreadyHandledError();
      }
      if (current.version !== dto.expectedVersion) {
        throw new AiSuggestionVersionConflictError();
      }

      // Contrôle stale — sauté seulement si l'agent confirme explicitement.
      if (!dto.confirmStale) {
        const stale = await this.isStale(tx, conversationId, current.contextLastMessageId);
        if (stale) {
          throw new AiSuggestionStaleError();
        }
      }

      const outbound = await this.messages.createOutboundInTx(tx, {
        organizationId: tenant.organizationId,
        conversation,
        userId: tenant.userId,
        text: dto.content,
        clientMessageId,
        dispatchId,
      });

      // Transition conditionnelle : GATE de l'acceptation (anti double-envoi).
      const transitioned = await tx.aiSuggestion.updateMany({
        where: { id: suggestionId, status: 'PENDING', version: dto.expectedVersion },
        data: {
          status: edited ? 'EDITED_AND_ACCEPTED' : 'ACCEPTED',
          editedContent: edited ? dto.content : null,
          sentMessageId: outbound.messageId,
          acceptedByUserId: tenant.userId,
          acceptedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (transitioned.count !== 1) {
        throw new AiSuggestionAlreadyHandledError();
      }

      await this.audit.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'AI_SUGGESTION_ACCEPTED',
          actorUserId: tenant.userId,
          // Jamais le contenu — seulement l'issue.
          metadata: { suggestionId, edited, sentMessageId: outbound.messageId },
          context,
        },
        tx,
      );

      return outbound;
    });

    const message = await this.messages.finalizeOutbound(
      tenant.organizationId,
      created.messageId,
      created.outboxEventId,
    );
    this.emitSuggestion(SOCKET_EVENTS.AI_SUGGESTION_CREATED, tenant.organizationId, conversation.shopId, conversationId, { suggestionId });

    const refreshed = await this.loadSuggestion(tenant, conversationId, suggestionId);
    return { suggestion: toSuggestionResponse(refreshed), message };
  }

  // -------------------------------------------------------------------- reject

  async reject(
    tenant: TenantContext,
    conversationId: string,
    suggestionId: string,
    dto: RejectSuggestionDto,
    context: AuditActionContext,
  ): Promise<AiSuggestionResponseDto> {
    await this.loadConversation(tenant, conversationId);
    const suggestion = await this.loadSuggestion(tenant, conversationId, suggestionId);
    if (suggestion.status !== 'PENDING') {
      throw new AiSuggestionAlreadyHandledError();
    }

    await this.prisma.$transaction(async (tx) => {
      const transitioned = await tx.aiSuggestion.updateMany({
        where: { id: suggestionId, status: 'PENDING', version: dto.expectedVersion },
        data: {
          status: 'REJECTED',
          rejectedByUserId: tenant.userId,
          rejectReason: dto.reason ?? null,
          rejectedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (transitioned.count !== 1) {
        // Distinguer conflit de version d'un rejet concurrent.
        const current = await tx.aiSuggestion.findUnique({
          where: { id: suggestionId },
          select: { status: true, version: true },
        });
        if (current && current.status !== 'PENDING') {
          throw new AiSuggestionAlreadyHandledError();
        }
        throw new AiSuggestionVersionConflictError();
      }
      await this.audit.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'AI_SUGGESTION_REJECTED',
          actorUserId: tenant.userId,
          metadata: { suggestionId },
          context,
        },
        tx,
      );
    });

    const refreshed = await this.loadSuggestion(tenant, conversationId, suggestionId);
    return toSuggestionResponse(refreshed);
  }

  // ------------------------------------------------------------------ helpers

  private async loadConversation(tenant: TenantContext, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: tenant.organizationId },
      select: { id: true, shopId: true },
    });
    if (!conversation) {
      throw new ConversationNotFoundError();
    }
    return conversation;
  }

  private async loadSuggestion(tenant: TenantContext, conversationId: string, suggestionId: string) {
    const suggestion = await this.prisma.aiSuggestion.findFirst({
      where: { id: suggestionId, organizationId: tenant.organizationId, conversationId },
    });
    if (!suggestion) {
      throw new AiSuggestionNotFoundError();
    }
    return suggestion;
  }

  /** Stale (ajustement 6) : nouveau message client / réponse humaine / handoff. */
  private async isStale(
    tx: Prisma.TransactionClient,
    conversationId: string,
    contextLastMessageId: string,
  ): Promise<boolean> {
    const anchor = await tx.message.findUnique({
      where: { id: contextLastMessageId },
      select: { createdAt: true },
    });
    if (!anchor) return true;

    const newer = await tx.message.count({
      where: {
        conversationId,
        createdAt: { gt: anchor.createdAt },
        OR: [
          { direction: 'INBOUND', senderType: 'CUSTOMER' },
          { direction: 'OUTBOUND' },
        ],
      },
    });
    if (newer > 0) return true;

    const handoff = await tx.conversationHandoff.count({
      where: { conversationId, status: { in: ['REQUESTED', 'ACCEPTED'] } },
    });
    return handoff > 0;
  }

  private async assertAiActive(tenant: TenantContext, shopId: string): Promise<void> {
    const config = await this.prisma.aiConfiguration.findFirst({
      where: { shopId, organizationId: tenant.organizationId },
      select: { mode: true },
    });
    const envMode = this.configService.get<AiMode>('AI_MODE') ?? 'SUGGEST_ONLY';
    if (resolveEffectiveMode(envMode, config?.mode ?? null) === 'DISABLED') {
      throw new AiDisabledError();
    }
  }

  /**
   * Pré-vérification crédits pour une génération MANUELLE (groupe 4). Lecture
   * seule et non autoritaire : distingue Wallet fermé/suspendu du solde
   * insuffisant (409 avec `availableCredits`/`requiredCredits`/`canTopUp`). La
   * réservation réelle reste faite atomiquement par le worker sous verrou.
   */
  private async assertCanReserveCredits(organizationId: string): Promise<void> {
    const wallet = await this.wallet.ensureWallet(organizationId);
    if (wallet.status === 'CLOSED') {
      throw new WalletClosedError();
    }
    if (wallet.status !== 'ACTIVE') {
      throw new WalletSuspendedError();
    }
    if (wallet.availableCredits < MAX_CREDITS_PER_AI_RUN) {
      throw new InsufficientCreditsError(wallet.availableCredits, MAX_CREDITS_PER_AI_RUN);
    }
  }

  private async assertNoOpenHandoff(conversationId: string): Promise<void> {
    const handoff = await this.prisma.conversationHandoff.findFirst({
      where: { conversationId, status: { in: ['REQUESTED', 'ACCEPTED'] } },
      select: { id: true },
    });
    if (handoff) {
      throw new AiConversationInHandoffError();
    }
  }

  private async enqueue(
    tenant: TenantContext,
    shopId: string,
    conversationId: string,
    triggerMessageId: string,
    channelId: string,
  ): Promise<void> {
    const jobId = aiDebounceJobId(conversationId);
    const payload: AiProcessMessageJobData = {
      organizationId: tenant.organizationId,
      shopId,
      conversationId,
      triggerMessageId,
      channelId,
      scheduledAt: new Date().toISOString(),
    };
    await this.aiQueue.remove(jobId).catch(() => undefined);
    await this.aiQueue.add('ai-process-message', payload, {
      jobId,
      delay: 0,
      removeOnComplete: true,
      removeOnFail: false,
    });
  }

  private emitSuggestion(
    event: string,
    organizationId: string,
    shopId: string,
    conversationId: string,
    extra: Partial<AiRealtimeEvent>,
  ): void {
    const payload: AiRealtimeEvent = {
      organizationId,
      shopId,
      conversationId,
      aiRunId: '',
      ...extra,
    };
    this.realtime.emitToOrganization(organizationId, event, payload);
  }
}
