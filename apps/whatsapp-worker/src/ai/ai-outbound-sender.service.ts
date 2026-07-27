import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import { SOCKET_EVENTS, toRealtimeMessage } from '@whauto/shared';
import type {
  ConversationChangedEvent,
  MessageCreatedEvent,
  WhatsAppMessageSendRequestedPayload,
  WhatsAppOutboundJobData,
} from '@whauto/shared';
import type { Queue } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import { AI_OUTBOUND_QUEUE } from '../whatsapp/whatsapp-queues.providers';
import { AiRealtimeEmitter } from './ai-realtime-emitter.service';

/** Transaction Prisma fournie (création DANS la transaction de commit du run en C2). */
export type PrismaTransaction = Prisma.TransactionClient;

/** Champs nécessaires à `toRealtimeMessage` — identiques à l'émission inbound. */
const AI_OUTBOUND_MESSAGE_SELECT = {
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
} satisfies Prisma.MessageSelect;

export interface AiOutboundConversation {
  id: string;
  shopId: string;
  channelId: string;
  contactId: string;
}

export interface CreateAiOutboundParams {
  organizationId: string;
  aiRunId: string;
  conversation: AiOutboundConversation;
  text: string;
  dispatchId: string;
}

/**
 * Chemin d'envoi outbound de l'IA (sous-phase C, groupe C1). RÉPLIQUE fidèle du
 * `MessagesService.createOutboundInTx` de l'API — même invariants : Message
 * OUTBOUND PENDING + compteurs de conversation + OutboxEvent dans UNE seule
 * transaction, puis publication BullMQ post-commit best-effort (le sweep de
 * récupération reprend les OutboxEvent PENDING). Différences avec l'envoi
 * humain : `senderType = AI`, `isAiGenerated = true`, `aiGeneratedByRunId` relie
 * le message au run (l'auto-envoi n'a pas d'AiSuggestion, donc pas de
 * `sentMessageId`) ; pas de `clientMessageId` ni de `senderUserId`.
 *
 * En C1 ce service N'EST PAS branché à la décision IA : il est exercé isolément
 * (test) via `sendAiReply`. En C2, la création passera par `createAiOutboundInTx`
 * DANS la transaction de commit du run (sous le verrou `FOR UPDATE` de la
 * conversation), suivie de `publishAndEmit` post-commit — jamais d'appel direct
 * au provider WhatsApp depuis l'IA. Le processor outbound reste l'autorité
 * finale sur la fenêtre 24 h et l'état du canal.
 */
@Injectable()
export class AiOutboundSenderService {
  private readonly logger = new Logger(AiOutboundSenderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: AiRealtimeEmitter,
    @Inject(AI_OUTBOUND_QUEUE) private readonly outboundQueue: Queue<WhatsAppOutboundJobData>,
  ) {}

  /**
   * Crée le Message OUTBOUND PENDING de l'IA + met à jour la conversation +
   * l'OutboxEvent dans la transaction FOURNIE. Ne publie rien et n'émet rien —
   * l'appelant appelle `publishAndEmit` APRÈS le commit.
   */
  async createAiOutboundInTx(
    tx: PrismaTransaction,
    params: CreateAiOutboundParams,
  ): Promise<{ messageId: string; outboxEventId: string }> {
    const now = new Date();
    const message = await tx.message.create({
      data: {
        organizationId: params.organizationId,
        shopId: params.conversation.shopId,
        conversationId: params.conversation.id,
        channelId: params.conversation.channelId,
        contactId: params.conversation.contactId,
        direction: 'OUTBOUND',
        type: 'TEXT',
        status: 'PENDING',
        senderType: 'AI',
        textContent: params.text,
        dispatchId: params.dispatchId,
        isAiGenerated: true,
        aiGeneratedByRunId: params.aiRunId,
      },
      select: { id: true },
    });
    await tx.conversation.update({
      where: { id: params.conversation.id },
      // `mode: AI` = badge « l'IA gère » (C3). L'auto-envoi n'arrive que si la
      // conversation n'est pas en pause (gate C2), donc on ne touche jamais
      // `aiAutoReplyPaused` ici.
      data: { lastMessageAt: now, lastOutboundMessageAt: now, mode: 'AI' },
      select: { id: true },
    });
    const outboxEvent = await tx.outboxEvent.create({
      data: {
        organizationId: params.organizationId,
        eventType: 'WHATSAPP_MESSAGE_SEND_REQUESTED',
        payload: { messageId: message.id, dispatchId: params.dispatchId },
      },
      select: { id: true },
    });
    return { messageId: message.id, outboxEventId: outboxEvent.id };
  }

  /**
   * Post-commit : publie l'OutboxEvent vers la queue outbound (best-effort) puis
   * émet `message.created` + `conversation.updated`. Une émission ratée ne fait
   * jamais échouer l'envoi (PostgreSQL reste la source de vérité).
   */
  async publishAndEmit(
    organizationId: string,
    messageId: string,
    outboxEventId: string,
  ): Promise<void> {
    await this.tryPublishOutbox(outboxEventId);
    await this.emitCreated(organizationId, messageId);
  }

  /**
   * Envoi complet dans une transaction dédiée. Utilisé en isolation (tests C1) ;
   * en C2 l'appelant préférera `createAiOutboundInTx` + `publishAndEmit` pour
   * rester atomique avec la finalisation du run.
   */
  async sendAiReply(params: {
    organizationId: string;
    aiRunId: string;
    conversationId: string;
    text: string;
  }): Promise<{ messageId: string; dispatchId: string }> {
    const conversation = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: params.conversationId },
      select: { id: true, shopId: true, channelId: true, contactId: true },
    });
    const dispatchId = randomUUID();
    const created = await this.prisma.$transaction((tx) =>
      this.createAiOutboundInTx(tx, {
        organizationId: params.organizationId,
        aiRunId: params.aiRunId,
        conversation,
        text: params.text,
        dispatchId,
      }),
    );
    await this.publishAndEmit(params.organizationId, created.messageId, created.outboxEventId);
    return { messageId: created.messageId, dispatchId };
  }

  /**
   * Publication best-effort (miroir du `OutboxPublisherService` de l'API). Un
   * échec Redis laisse l'OutboxEvent PENDING → le sweep de récupération le
   * republiera. jobId = dispatchId : jamais de second envoi logique.
   */
  private async tryPublishOutbox(outboxEventId: string): Promise<void> {
    const event = await this.prisma.outboxEvent.findUnique({
      where: { id: outboxEventId },
      select: { id: true, status: true, eventType: true, payload: true },
    });
    if (!event || event.status === 'PUBLISHED') {
      return;
    }
    if (event.eventType !== 'WHATSAPP_MESSAGE_SEND_REQUESTED') {
      this.logger.error(`OutboxEvent ${event.id} de type inattendu: ${event.eventType}`);
      return;
    }

    const payload = event.payload as unknown as WhatsAppMessageSendRequestedPayload;
    try {
      await this.outboundQueue.add(
        'send-message',
        { messageId: payload.messageId, dispatchId: payload.dispatchId },
        { jobId: payload.dispatchId },
      );
      await this.prisma.outboxEvent.updateMany({
        where: { id: event.id, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'PUBLISHED', publishedAt: new Date(), attemptCount: { increment: 1 } },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Publication outbox IA ${event.id} échouée (reste PENDING, le sweep la reprendra) : ${message}`,
      );
      await this.prisma.outboxEvent
        .updateMany({
          where: { id: event.id, status: 'PENDING' },
          data: { attemptCount: { increment: 1 }, lastErrorMessage: message.slice(0, 500) },
        })
        .catch(() => undefined);
    }
  }

  /** Émet `message.created` + `conversation.updated` (fire-and-forget). */
  private async emitCreated(organizationId: string, messageId: string): Promise<void> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: AI_OUTBOUND_MESSAGE_SELECT,
    });
    if (!message) {
      return;
    }
    const scope: ConversationChangedEvent = {
      organizationId,
      shopId: message.shopId,
      conversationId: message.conversationId,
    };
    const payload: MessageCreatedEvent = { ...scope, message: toRealtimeMessage(message) };
    this.realtime.emitToOrganization(organizationId, SOCKET_EVENTS.MESSAGE_CREATED, payload);
    this.realtime.emitToOrganization(organizationId, SOCKET_EVENTS.CONVERSATION_UPDATED, scope);
  }
}
