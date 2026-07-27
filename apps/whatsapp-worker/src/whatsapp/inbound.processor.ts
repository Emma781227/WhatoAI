import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SOCKET_EVENTS, toRealtimeMessage, WHATSAPP_QUEUES } from '@whauto/shared';
import type {
  ConversationChangedEvent,
  ConversationUnreadUpdatedEvent,
  MessageCreatedEvent,
  WhatsAppInboundJobData,
} from '@whauto/shared';
import type { NormalizedInboundEvent } from '@whauto/whatsapp';
import { isSupportedInboundMessageType } from '@whauto/whatsapp';
import type { Job } from 'bullmq';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { AiSchedulingService } from '../ai/ai-scheduling.service';
import { PrismaService } from '../prisma/prisma.service';
import { InboundProcessingService, UnprocessableInboundEventError } from './inbound-processing.service';
import type { InboundMessageResult } from './inbound-processing.service';
import { MessageStatusService } from './message-status.service';
import { RealtimeEmitterService } from './realtime-emitter.service';
import { WHATSAPP_WORKER_REDIS } from './whatsapp-queues.providers';

/**
 * Consommateur whatsapp-inbound. Le job ne porte qu'une référence vers la
 * durable inbox : la vérité est TOUJOURS relue en base. Idempotence par
 * "claim" conditionnel (RECEIVED/QUEUED/FAILED → PROCESSING) : un job
 * dupliqué ou re-swept ne retraite jamais un événement PROCESSED.
 */
@Injectable()
export class InboundProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboundProcessor.name);
  private worker?: Worker<WhatsAppInboundJobData>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inboundProcessing: InboundProcessingService,
    private readonly messageStatus: MessageStatusService,
    private readonly realtimeEmitter: RealtimeEmitterService,
    private readonly aiScheduling: AiSchedulingService,
    private readonly configService: ConfigService,
    @Inject(WHATSAPP_WORKER_REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<WhatsAppInboundJobData>(
      WHATSAPP_QUEUES.INBOUND,
      (job) => this.process(job),
      { connection: this.redis, concurrency: 5 },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.warn(
        `Job inbound ${job?.id ?? '?'} en échec (tentative ${job?.attemptsMade ?? '?'}) : ${error.message}`,
      );
    });
  }

  async process(job: Job<WhatsAppInboundJobData>): Promise<void> {
    const { inboundEventId } = job.data;

    const event = await this.prisma.whatsAppInboundEvent.findUnique({
      where: { id: inboundEventId },
      select: {
        id: true,
        status: true,
        eventKind: true,
        payload: true,
        attemptCount: true,
        channel: { select: { id: true, organizationId: true, shopId: true } },
      },
    });
    if (!event) {
      this.logger.error(`Événement entrant introuvable: ${inboundEventId}`);
      return;
    }
    if (event.status === 'PROCESSED') {
      return; // Déjà traité (job dupliqué, sweep, retry BullMQ après commit).
    }

    // Claim conditionnel — un seul worker traite un événement à la fois.
    // WAITING_MESSAGE est claimable : le sweep le republie pour réconciliation.
    const claimed = await this.prisma.whatsAppInboundEvent.updateMany({
      where: { id: event.id, status: { in: ['RECEIVED', 'QUEUED', 'FAILED', 'WAITING_MESSAGE'] } },
      data: { status: 'PROCESSING', attemptCount: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      return; // PROCESSING ailleurs ou PROCESSED/ORPHANED entre-temps.
    }

    try {
      const normalized = event.payload as unknown as NormalizedInboundEvent;

      if (normalized.kind === 'message') {
        const result = await this.inboundProcessing.processMessage(event.channel, normalized);
        if (result.created) {
          await this.emitInboundEvents(result);
          // Planification IA APRÈS le commit inbound (ajustement 1) : uniquement
          // pour un message REELLEMENT nouveau et d'un type texte supporté —
          // jamais pour un média (ajustement 3) ni pour une relivraison. Toutes
          // les autres gardes sont rejouées par le processor IA à l'exécution.
          if (isSupportedInboundMessageType(normalized.messageType)) {
            await this.scheduleAi(result);
          }
        }
      } else if (normalized.kind === 'status') {
        const result = await this.messageStatus.apply({
          channelId: event.channel.id,
          externalMessageId: normalized.externalMessageId,
          status: normalized.status,
          providerTimestamp: normalized.providerTimestamp,
          errorCode: normalized.errorCode,
          errorMessage: normalized.errorMessage,
        });
        if (!result.messageFound) {
          // Statut orphelin : le Message sortant n'existe pas encore. On
          // n'échoue PAS — on attend sa réconciliation par le sweep.
          await this.prisma.whatsAppInboundEvent.updateMany({
            where: { id: event.id, status: 'PROCESSING' },
            data: { status: 'WAITING_MESSAGE' },
          });
          return;
        }
      } else {
        throw new UnprocessableInboundEventError(`kind inconnu: ${event.eventKind}`);
      }

      await this.prisma.whatsAppInboundEvent.updateMany({
        where: { id: event.id, status: 'PROCESSING' },
        data: { status: 'PROCESSED', processedAt: new Date() },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.whatsAppInboundEvent.updateMany({
        where: { id: event.id, status: 'PROCESSING' },
        data: {
          status: 'FAILED',
          failedAt: new Date(),
          lastErrorCode:
            error instanceof UnprocessableInboundEventError ? 'UNPROCESSABLE' : 'PROCESSING_ERROR',
          lastErrorMessage: message.slice(0, 500),
        },
      });

      if (error instanceof UnprocessableInboundEventError) {
        // Définitivement invalide : inutile de faire retenter BullMQ.
        this.logger.error(`Événement entrant ${event.id} non traitable : ${message}`);
        return;
      }
      // Erreur transitoire : BullMQ retente (attempts/backoff), puis le sweep
      // reprend les FAILED sous le plafond de tentatives.
      throw error;
    }
  }

  /**
   * Planifie (best-effort) la génération IA pour le message qui vient d'être
   * commité. Une publication perdue n'est jamais fatale : le message reste
   * éligible et AiRecoveryService le rattrape.
   */
  private async scheduleAi(result: InboundMessageResult): Promise<void> {
    await this.aiScheduling.scheduleDebounced(
      {
        organizationId: result.organizationId,
        shopId: result.shopId,
        conversationId: result.conversationId,
        triggerMessageId: result.messageId,
        channelId: result.channelId,
      },
      Date.now(),
    );
  }

  /**
   * Émissions post-commit pour un message entrant : conversation.created ou
   * conversation.updated + message.created + conversation.unread.updated —
   * avec l'état RÉEL relu en base.
   */
  private async emitInboundEvents(result: InboundMessageResult): Promise<void> {
    const [message, conversation] = await Promise.all([
      this.prisma.message.findUnique({
        where: { id: result.messageId },
        select: {
          id: true,
          organizationId: true,
          shopId: true,
          conversationId: true,
          channelId: true,
          contactId: true,
          clientMessageId: true,
          direction: true,
          type: true,
          status: true,
          senderType: true,
          senderUserId: true,
          textContent: true,
          mediaUrl: true,
          mediaMimeType: true,
          mediaFileName: true,
          quotedMessageId: true,
          errorCode: true,
          errorMessage: true,
          sentAt: true,
          deliveredAt: true,
          readAt: true,
          failedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.conversation.findUnique({
        where: { id: result.conversationId },
        select: { unreadCount: true },
      }),
    ]);
    if (!message || !conversation) {
      return;
    }

    const scope: ConversationChangedEvent = {
      organizationId: result.organizationId,
      shopId: result.shopId,
      conversationId: result.conversationId,
    };

    this.realtimeEmitter.emitToOrganization(
      result.organizationId,
      result.conversationCreated
        ? SOCKET_EVENTS.CONVERSATION_CREATED
        : SOCKET_EVENTS.CONVERSATION_UPDATED,
      scope,
    );

    const messagePayload: MessageCreatedEvent = {
      ...scope,
      message: toRealtimeMessage(message),
    };
    this.realtimeEmitter.emitToOrganization(
      result.organizationId,
      SOCKET_EVENTS.MESSAGE_CREATED,
      messagePayload,
    );

    const unreadPayload: ConversationUnreadUpdatedEvent = {
      ...scope,
      unreadCount: conversation.unreadCount,
    };
    this.realtimeEmitter.emitToOrganization(
      result.organizationId,
      SOCKET_EVENTS.CONVERSATION_UNREAD_UPDATED,
      unreadPayload,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
