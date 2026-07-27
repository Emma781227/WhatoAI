import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import {
  ConversationClosedError,
  ConversationNotFoundError,
  CustomerServiceWindowExpiredError,
  isCustomerServiceWindowOpen,
  MessageNotFoundError,
  MessageNotRetryableError,
  SOCKET_EVENTS,
  toRealtimeMessage,
  WhatsAppChannelNotConnectedError,
} from '@whauto/shared';
import type { MessageCreatedEvent, MessageStatusUpdatedEvent } from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { OutboxPublisherService } from '../outbox/outbox-publisher.service';
import { decodeCursor, encodeCursor } from './cursor.util';
import { MESSAGE_PUBLIC_SELECT } from './conversations.mapper';
import type { MessagePublic } from './conversations.mapper';

export interface ListMessagesQuery {
  cursor?: string;
  limit: number;
}

export interface SendMessageInput {
  text: string;
  clientMessageId: string;
}

/** Conversation résolue + scellée pour l'envoi (partagée avec le module IA). */
export interface SendableConversation {
  id: string;
  shopId: string;
  channelId: string;
  contactId: string;
  status: string;
  customerServiceWindowExpiresAt: Date | null;
  channel: { status: string };
}

/** Transaction Prisma (type dérivé, pour les créations réutilisables). */
export type PrismaTransaction = Prisma.TransactionClient;

function isClientMessageIdConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  return Array.isArray(target) && target.includes('clientMessageId');
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outboxPublisher: OutboxPublisherService,
    private readonly realtime: RealtimeService,
  ) {}

  private emitMessageCreated(message: MessagePublic): void {
    const payload: MessageCreatedEvent = {
      organizationId: message.organizationId,
      shopId: message.shopId,
      conversationId: message.conversationId,
      message: toRealtimeMessage(message),
    };
    this.realtime.emitToOrganization(
      message.organizationId,
      SOCKET_EVENTS.MESSAGE_CREATED,
      payload,
    );
  }

  private emitStatusUpdated(message: MessagePublic): void {
    const payload: MessageStatusUpdatedEvent = {
      organizationId: message.organizationId,
      shopId: message.shopId,
      conversationId: message.conversationId,
      messageId: message.id,
      clientMessageId: message.clientMessageId,
      status: message.status,
      sentAt: message.sentAt?.toISOString() ?? null,
      deliveredAt: message.deliveredAt?.toISOString() ?? null,
      readAt: message.readAt?.toISOString() ?? null,
      failedAt: message.failedAt?.toISOString() ?? null,
      errorCode: message.errorCode,
      errorMessage: message.errorMessage,
    };
    this.realtime.emitToOrganization(
      message.organizationId,
      SOCKET_EVENTS.MESSAGE_STATUS_UPDATED,
      payload,
    );
  }

  // --------------------------------------------------------------------- read

  /** Fil descendant (les plus récents d'abord) — le frontend inverse à l'affichage. */
  async list(
    tenant: TenantContext,
    conversationId: string,
    query: ListMessagesQuery,
  ): Promise<{ items: MessagePublic[]; nextCursor: string | null }> {
    await this.getConversationScoped(tenant, conversationId);

    const where: Prisma.MessageWhereInput = { conversationId };
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      const pivot = new Date(cursor.t);
      where.OR = [{ createdAt: { lt: pivot } }, { createdAt: pivot, id: { lt: cursor.id } }];
    }

    const rows = await this.prisma.message.findMany({
      where,
      select: MESSAGE_PUBLIC_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    const nextCursor =
      rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null;
    return { items, nextCursor };
  }

  // --------------------------------------------------------------------- send

  /**
   * Envoi transactionnel (transactional outbox) : Message PENDING + compteurs
   * de conversation + OutboxEvent dans la MÊME transaction, puis publication
   * BullMQ post-commit (best-effort — le sweep du worker reprend les PENDING).
   *
   * Idempotence frontend : un retry réseau avec le même clientMessageId
   * retourne le message déjà créé (P2002 sur conversationId+clientMessageId).
   */
  async send(
    tenant: TenantContext,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<MessagePublic> {
    const conversation = await this.loadSendableConversation(tenant, conversationId);
    this.assertSendable(conversation);

    const dispatchId = randomUUID();

    let created: { messageId: string; outboxEventId: string };
    try {
      created = await this.prisma.$transaction((tx) =>
        this.createOutboundInTx(tx, {
          organizationId: tenant.organizationId,
          conversation,
          userId: tenant.userId,
          text: input.text,
          clientMessageId: input.clientMessageId,
          dispatchId,
        }),
      );
    } catch (error) {
      if (isClientMessageIdConflict(error)) {
        // Retry réseau du même envoi : renvoyer le message existant tel quel.
        return this.prisma.message.findUniqueOrThrow({
          where: {
            conversationId_clientMessageId: {
              conversationId: conversation.id,
              clientMessageId: input.clientMessageId,
            },
          },
          select: MESSAGE_PUBLIC_SELECT,
        });
      }
      throw error;
    }

    return this.finalizeOutbound(tenant.organizationId, created.messageId, created.outboxEventId);
  }

  /**
   * Charge une conversation scopée par tenant, avec les champs nécessaires à
   * l'envoi. Partagé avec le module IA (acceptation de suggestion).
   */
  async loadSendableConversation(
    tenant: TenantContext,
    conversationId: string,
  ): Promise<SendableConversation> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: tenant.organizationId },
      select: {
        id: true,
        shopId: true,
        channelId: true,
        contactId: true,
        status: true,
        customerServiceWindowExpiresAt: true,
        channel: { select: { status: true } },
      },
    });
    if (!conversation) {
      throw new ConversationNotFoundError();
    }
    return conversation;
  }

  /** Vérifie qu'un message sortant peut être envoyé (feedback API immédiat). */
  assertSendable(conversation: SendableConversation): void {
    if (conversation.status === 'CLOSED' || conversation.status === 'RESOLVED') {
      throw new ConversationClosedError();
    }
    if (conversation.channel.status !== 'CONNECTED') {
      throw new WhatsAppChannelNotConnectedError();
    }
    // Le worker re-vérifie au moment réel de l'envoi (autorité finale).
    if (!isCustomerServiceWindowOpen(conversation.customerServiceWindowExpiresAt, new Date())) {
      throw new CustomerServiceWindowExpiredError();
    }
  }

  /**
   * Crée un Message OUTBOUND PENDING + met à jour la conversation + l'OutboxEvent
   * dans UNE transaction fournie. Réutilisé par l'envoi humain ET l'acceptation
   * d'une suggestion IA — un seul chemin d'envoi, jamais d'appel direct au
   * provider depuis le module IA.
   */
  async createOutboundInTx(
    tx: PrismaTransaction,
    params: {
      organizationId: string;
      conversation: Pick<SendableConversation, 'id' | 'shopId' | 'channelId' | 'contactId'>;
      userId: string;
      text: string;
      clientMessageId: string;
      dispatchId: string;
    },
  ): Promise<{ messageId: string; outboxEventId: string }> {
    const now = new Date();
    const message = await tx.message.create({
      data: {
        organizationId: params.organizationId,
        shopId: params.conversation.shopId,
        conversationId: params.conversation.id,
        channelId: params.conversation.channelId,
        contactId: params.conversation.contactId,
        clientMessageId: params.clientMessageId,
        direction: 'OUTBOUND',
        type: 'TEXT',
        status: 'PENDING',
        senderType: 'AGENT',
        senderUserId: params.userId,
        textContent: params.text,
        dispatchId: params.dispatchId,
      },
      select: { id: true },
    });
    await tx.conversation.update({
      where: { id: params.conversation.id },
      // Reprise humaine (sous-phase C) : tout envoi sortant HUMAIN — message
      // manuel OU acceptation d'une suggestion IA — bascule la conversation en
      // mode HUMAN et suspend l'auto-réponse (jusqu'à une reprise explicite).
      // L'auto-envoi de l'IA passe par un autre chemin (worker) et met mode=AI.
      data: {
        lastMessageAt: now,
        lastOutboundMessageAt: now,
        mode: 'HUMAN',
        aiAutoReplyPaused: true,
      },
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

  /** Post-commit partagé : publie l'outbox (best-effort) + émet les événements. */
  async finalizeOutbound(
    organizationId: string,
    messageId: string,
    outboxEventId: string,
  ): Promise<MessagePublic> {
    await this.outboxPublisher.tryPublish(outboxEventId);

    const message = await this.prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      select: MESSAGE_PUBLIC_SELECT,
    });

    this.emitMessageCreated(message);
    this.realtime.emitToOrganization(organizationId, SOCKET_EVENTS.CONVERSATION_UPDATED, {
      organizationId,
      shopId: message.shopId,
      conversationId: message.conversationId,
    });

    return message;
  }

  // -------------------------------------------------------------------- retry

  /**
   * Retry explicite d'un message FAILED : SEULE transition FAILED → PENDING
   * autorisée. Nouveau dispatchId (nouveau cycle d'envoi, nouveau jobId) +
   * nouvel OutboxEvent dans la même transaction.
   */
  async retry(
    tenant: TenantContext,
    conversationId: string,
    messageId: string,
  ): Promise<MessagePublic> {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId, organizationId: tenant.organizationId },
      select: { id: true, direction: true, status: true },
    });
    if (!message) {
      throw new MessageNotFoundError();
    }
    if (message.direction !== 'OUTBOUND' || message.status !== 'FAILED') {
      throw new MessageNotRetryableError(message.status);
    }

    const dispatchId = randomUUID();

    const outboxEventId = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.message.updateMany({
        where: { id: messageId, status: 'FAILED' },
        data: {
          status: 'PENDING',
          dispatchId,
          errorCode: null,
          errorMessage: null,
          failedAt: null,
        },
      });
      if (updated.count !== 1) {
        // Retenté concurremment.
        throw new MessageNotRetryableError('PENDING');
      }

      const outboxEvent = await tx.outboxEvent.create({
        data: {
          organizationId: tenant.organizationId,
          eventType: 'WHATSAPP_MESSAGE_SEND_REQUESTED',
          payload: { messageId, dispatchId },
        },
        select: { id: true },
      });
      return outboxEvent.id;
    });

    await this.outboxPublisher.tryPublish(outboxEventId);

    const retried = await this.prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      select: MESSAGE_PUBLIC_SELECT,
    });
    this.emitStatusUpdated(retried);
    return retried;
  }

  // --------------------------------------------------------------------- note

  /**
   * Note interne : Message INTERNAL/INTERNAL_NOTE/AGENT, statut RECEIVED
   * (terminal — jamais envoyée au provider, jamais de file d'envoi).
   * N'incrémente pas unreadCount et ne réordonne pas l'inbox (lastMessageAt
   * inchangé) : une note n'est pas une activité client.
   */
  async addNote(
    tenant: TenantContext,
    conversationId: string,
    text: string,
  ): Promise<MessagePublic> {
    const conversation = await this.getConversationScoped(tenant, conversationId);

    const note = await this.prisma.message.create({
      data: {
        organizationId: tenant.organizationId,
        shopId: conversation.shopId,
        conversationId: conversation.id,
        channelId: conversation.channelId,
        contactId: conversation.contactId,
        direction: 'INTERNAL',
        type: 'INTERNAL_NOTE',
        status: 'RECEIVED',
        senderType: 'AGENT',
        senderUserId: tenant.userId,
        textContent: text,
      },
      select: MESSAGE_PUBLIC_SELECT,
    });

    // La room organisation est réservée à l'équipe : une note interne peut y
    // être diffusée — elle n'atteint jamais le provider ni le client final.
    this.emitMessageCreated(note);
    return note;
  }

  // ------------------------------------------------------------------ helpers

  private async getConversationScoped(tenant: TenantContext, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: tenant.organizationId },
      select: { id: true, shopId: true, channelId: true, contactId: true, status: true },
    });
    if (!conversation) {
      throw new ConversationNotFoundError();
    }
    return conversation;
  }
}
