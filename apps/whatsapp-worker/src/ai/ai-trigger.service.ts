import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type AiMode, type AiProviderType, Prisma } from '@whauto/database';
import type { AiProcessMessageJobData } from '@whauto/shared';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Décide, pour UN message déclencheur, s'il faut créer un AiRun — et le crée.
 *
 * Toutes les gardes sont REJOUÉES ici (ajustement 1) : l'InboundProcessor ne
 * fait que planifier, la vérité est ré-établie au moment de l'exécution, en
 * base, éventuellement après plusieurs secondes de debounce pendant lesquelles
 * l'état a pu changer (handoff ouvert, IA désactivée, réponse humaine…).
 */

export type AiTriggerOutcome =
  | 'RUN_CREATED'
  | 'SUPERSEDED_AND_CREATED'
  | 'ALREADY_RUN' // idempotent : un run logique existe déjà pour ce déclencheur
  | 'HANDOFF_SKIPPED' // handoff ouvert → run SKIPPED tracé, jamais de génération
  | 'SKIPPED_GLOBAL_DISABLED'
  | 'SKIPPED_SHOP_DISABLED'
  | 'SKIPPED_MESSAGE_GONE'
  | 'SKIPPED_NOT_ELIGIBLE'
  | 'SKIPPED_UNSUPPORTED_TYPE'
  | 'SKIPPED_TENANT_MISMATCH'
  | 'SKIPPED_CHANNEL_NOT_CONNECTED'
  | 'SKIPPED_MISCONFIGURED';

export interface AiTriggerResult {
  outcome: AiTriggerOutcome;
  runId: string | null;
  supersededRunId: string | null;
}

/**
 * Résolution du mode effectif (ajustement 2) :
 * 1. `AI_MODE=DISABLED` (env) est un coupe-circuit GLOBAL ;
 * 2. sinon `AiConfiguration.mode` fait autorité SI la ligne existe ;
 * 3. sinon `AI_MODE` (env) sert de défaut.
 */
export function resolveEffectiveAiMode(envMode: AiMode, configMode: AiMode | null): AiMode {
  if (envMode === 'DISABLED') {
    return 'DISABLED';
  }
  return configMode ?? envMode;
}

const ACTIVE_RUN_STATUSES = ['QUEUED', 'RUNNING', 'WAITING_TOOL'] as const;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class AiTriggerService {
  private readonly logger = new Logger(AiTriggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async processTrigger(data: AiProcessMessageJobData): Promise<AiTriggerResult> {
    const skip = (outcome: AiTriggerOutcome): AiTriggerResult => ({
      outcome,
      runId: null,
      supersededRunId: null,
    });

    // 1. Coupe-circuit GLOBAL — avant toute lecture métier.
    const envMode = this.configService.get<AiMode>('AI_MODE') ?? 'SUGGEST_ONLY';
    if (envMode === 'DISABLED') {
      return skip('SKIPPED_GLOBAL_DISABLED');
    }

    // 2. Message présent + éligible + cohérence tenant/Shop/Conversation/Channel.
    const message = await this.prisma.message.findUnique({
      where: { id: data.triggerMessageId },
      select: {
        id: true,
        organizationId: true,
        shopId: true,
        conversationId: true,
        channelId: true,
        direction: true,
        senderType: true,
        type: true,
        channel: { select: { status: true } },
      },
    });
    if (!message) {
      return skip('SKIPPED_MESSAGE_GONE');
    }
    if (message.direction !== 'INBOUND' || message.senderType !== 'CUSTOMER') {
      return skip('SKIPPED_NOT_ELIGIBLE');
    }
    // Seul TEXT est réellement supporté (ajustement 3) — jamais de run média.
    if (message.type !== 'TEXT') {
      return skip('SKIPPED_UNSUPPORTED_TYPE');
    }
    if (
      message.organizationId !== data.organizationId ||
      message.shopId !== data.shopId ||
      message.conversationId !== data.conversationId ||
      message.channelId !== data.channelId
    ) {
      return skip('SKIPPED_TENANT_MISMATCH');
    }
    if (message.channel.status !== 'CONNECTED') {
      return skip('SKIPPED_CHANNEL_NOT_CONNECTED');
    }

    // 3. Configuration par Shop → mode effectif.
    const config = await this.prisma.aiConfiguration.findUnique({
      where: { shopId: data.shopId },
      select: { provider: true, mode: true, model: true },
    });
    const effectiveMode = resolveEffectiveAiMode(envMode, config?.mode ?? null);
    if (effectiveMode === 'DISABLED') {
      return skip('SKIPPED_SHOP_DISABLED');
    }

    // 4. Provider + modèle (aucun nom de modèle en dur — env ou config).
    const provider: AiProviderType =
      config?.provider ?? this.configService.get<AiProviderType>('AI_PROVIDER') ?? 'MOCK';
    const model =
      config?.model ??
      this.configService.get<string>('GEMINI_MODEL') ??
      (provider === 'MOCK' ? 'mock-model' : null);
    if (model === null) {
      // GEMINI sans modèle configuré : on ne devine jamais un nom de modèle.
      this.logger.warn(`Modèle IA absent pour la Shop ${data.shopId} (provider ${provider}).`);
      return skip('SKIPPED_MISCONFIGURED');
    }

    // 5. Handoff ouvert → run SKIPPED tracé (ajustement 9), jamais de génération.
    const openHandoff = await this.prisma.conversationHandoff.findFirst({
      where: { conversationId: data.conversationId, status: { in: ['REQUESTED', 'ACCEPTED'] } },
      select: { id: true },
    });
    if (openHandoff) {
      const runId = await this.createSkippedRun(data, provider, model, effectiveMode);
      return { outcome: 'HANDOFF_SKIPPED', runId, supersededRunId: null };
    }

    // 6. Création (+ supersede éventuel) SOUS verrou de la Conversation.
    return this.createRunUnderLock(data, provider, model, effectiveMode);
  }

  /**
   * Crée un run terminal SKIPPED (handoff) : consomme le déclencheur
   * (triggerMessageId unique) donc bloque toute reprise, et laisse une trace
   * avec un code interne filtré — jamais de détail sensible.
   */
  private async createSkippedRun(
    data: AiProcessMessageJobData,
    provider: AiProviderType,
    model: string,
    mode: AiMode,
  ): Promise<string | null> {
    try {
      const run = await this.prisma.aiRun.create({
        data: {
          organizationId: data.organizationId,
          shopId: data.shopId,
          conversationId: data.conversationId,
          triggerMessageId: data.triggerMessageId,
          contextLastMessageId: data.triggerMessageId,
          provider,
          model,
          mode,
          status: 'SKIPPED',
          errorCode: 'AI_BLOCKED_BY_HANDOFF',
          completedAt: new Date(),
        },
        select: { id: true },
      });
      return run.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null; // Un run existe déjà pour ce déclencheur : no-op idempotent.
      }
      throw error;
    }
  }

  private async createRunUnderLock(
    data: AiProcessMessageJobData,
    provider: AiProviderType,
    model: string,
    mode: AiMode,
  ): Promise<AiTriggerResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Sérialise supersede + création par conversation : deux triggers
        // concurrents ne peuvent jamais produire deux runs actifs.
        await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${data.conversationId} FOR UPDATE`;

        // Idempotence : un run existe-t-il déjà pour CE déclencheur ?
        const existing = await tx.aiRun.findUnique({
          where: { triggerMessageId: data.triggerMessageId },
          select: { id: true },
        });
        if (existing) {
          return { outcome: 'ALREADY_RUN' as const, runId: existing.id, supersededRunId: null };
        }

        // Run actif d'un déclencheur ANTÉRIEUR → SUPERSEDED (ajustement 7) :
        // la ligne est conservée, jamais supprimée ; sa suggestion PENDING
        // éventuelle passe EXPIRED (jamais supprimée non plus).
        const active = await tx.aiRun.findFirst({
          where: {
            conversationId: data.conversationId,
            status: { in: [...ACTIVE_RUN_STATUSES] },
          },
          select: { id: true },
        });

        const run = await tx.aiRun.create({
          data: {
            organizationId: data.organizationId,
            shopId: data.shopId,
            conversationId: data.conversationId,
            triggerMessageId: data.triggerMessageId,
            contextLastMessageId: data.triggerMessageId,
            provider,
            model,
            // Modèle demandé (config/env) figé au run ; resolvedModel sera
            // rempli à la génération avec le modèle réellement servi.
            requestedModel: model,
            mode,
            status: 'QUEUED',
          },
          select: { id: true },
        });

        if (active) {
          await tx.aiRun.update({
            where: { id: active.id },
            data: { status: 'SUPERSEDED', supersededByRunId: run.id, completedAt: new Date() },
          });
          await tx.aiSuggestion.updateMany({
            where: { aiRunId: active.id, status: 'PENDING' },
            data: { status: 'EXPIRED' },
          });
          return {
            outcome: 'SUPERSEDED_AND_CREATED' as const,
            runId: run.id,
            supersededRunId: active.id,
          };
        }
        return { outcome: 'RUN_CREATED' as const, runId: run.id, supersededRunId: null };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Course perdue (triggerMessageId ou index « un actif par conversation ») :
        // un autre worker a créé le run — no-op idempotent, jamais une erreur.
        const existing = await this.prisma.aiRun.findUnique({
          where: { triggerMessageId: data.triggerMessageId },
          select: { id: true },
        });
        return { outcome: 'ALREADY_RUN', runId: existing?.id ?? null, supersededRunId: null };
      }
      throw error;
    }
  }
}
