import { Injectable, Logger } from '@nestjs/common';
import { MessageType, Prisma } from '@whauto/database';
import { computeCustomerServiceWindowExpiry } from '@whauto/shared';
import { normalizePhoneNumber } from '@whauto/whatsapp';
import type { InboundMessageContentType, NormalizedInboundMessageEvent } from '@whauto/whatsapp';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Mapping type de contenu entrant → MessageType Prisma. Le VRAI type est
 * conservé (jamais converti en texte) ; l'UI génère le libellé « média non
 * pris en charge ». CONTACTS → CONTACT (nom Prisma existant).
 */
const MESSAGE_TYPE_MAP: Record<InboundMessageContentType, MessageType> = {
  TEXT: MessageType.TEXT,
  IMAGE: MessageType.IMAGE,
  AUDIO: MessageType.AUDIO,
  VIDEO: MessageType.VIDEO,
  DOCUMENT: MessageType.DOCUMENT,
  LOCATION: MessageType.LOCATION,
  CONTACTS: MessageType.CONTACT,
  STICKER: MessageType.STICKER,
  UNSUPPORTED: MessageType.UNSUPPORTED,
};

export interface InboundMessageResult {
  organizationId: string;
  shopId: string;
  channelId: string;
  contactId: string;
  conversationId: string;
  messageId: string;
  conversationCreated: boolean;
  /** false = message déjà connu (relivraison), rien n'a été modifié. */
  created: boolean;
}

/** Erreur non-retryable : l'événement est définitivement invalide. */
export class UnprocessableInboundEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnprocessableInboundEventError';
  }
}

function isUniqueViolation(error: unknown, column?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  if (column === undefined) {
    return true;
  }
  const target = error.meta?.target;
  return Array.isArray(target) && target.includes(column);
}

/**
 * Cœur métier de l'inbound : Contact + Conversation + Message + compteurs,
 * le tout dans UNE transaction. Idempotent à chaque étage : upsert contact,
 * index partiel conversation (retry sur P2002), contrainte unique message
 * (relivraison → no-op). Deux webhooks identiques ne créent ni deux contacts,
 * ni deux conversations, ni deux messages.
 */
@Injectable()
export class InboundProcessingService {
  private readonly logger = new Logger(InboundProcessingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async processMessage(
    channel: { id: string; organizationId: string; shopId: string },
    event: NormalizedInboundMessageEvent,
  ): Promise<InboundMessageResult> {
    const normalizedPhone = normalizePhoneNumber(event.from);
    if (normalizedPhone === null) {
      throw new UnprocessableInboundEventError(`Numéro invalide: ${event.from}`);
    }
    // Rétrocompatibilité : un payload durable sans messageType (persisté avant
    // l'ajout du champ, ou événement fabriqué) est un message TEXTE par défaut.
    const messageType = event.messageType ?? 'TEXT';

    const now = new Date();
    const providerTimestamp = this.boundedTimestamp(event.providerTimestamp, now);

    return this.prisma.$transaction(async (tx) => {
      // 1. Contact — upsert par (shopId, normalizedPhone). Le displayName
      // fourni par le client rafraîchit la fiche (jamais l'inverse).
      const contact = await tx.contact.upsert({
        where: { shopId_normalizedPhone: { shopId: channel.shopId, normalizedPhone } },
        create: {
          organizationId: channel.organizationId,
          shopId: channel.shopId,
          whatsappPhone: event.from,
          normalizedPhone,
          displayName: event.displayName ?? null,
          lastActivityAt: now,
        },
        update: {
          lastActivityAt: now,
          ...(event.displayName !== undefined ? { displayName: event.displayName } : {}),
        },
        select: { id: true },
      });

      // 2. Conversation active (OPEN/PENDING) ou création OPEN. Une dernière
      // conversation RESOLVED/CLOSED n'est JAMAIS rouverte automatiquement :
      // le nouveau message ouvre une nouvelle conversation (décision validée).
      let conversationCreated = false;
      let conversation = await tx.conversation.findFirst({
        where: {
          channelId: channel.id,
          contactId: contact.id,
          status: { in: ['OPEN', 'PENDING'] },
        },
        select: { id: true, customerServiceWindowExpiresAt: true, unreadCount: true },
      });
      if (!conversation) {
        try {
          conversation = await tx.conversation.create({
            data: {
              organizationId: channel.organizationId,
              shopId: channel.shopId,
              channelId: channel.id,
              contactId: contact.id,
              status: 'OPEN',
              lastMessageAt: now,
            },
            select: { id: true, customerServiceWindowExpiresAt: true, unreadCount: true },
          });
          conversationCreated = true;
        } catch (error) {
          if (!isUniqueViolation(error)) {
            throw error;
          }
          // Un webhook concurrent l'a créée : l'index partiel a tranché.
          conversation = await tx.conversation.findFirstOrThrow({
            where: {
              channelId: channel.id,
              contactId: contact.id,
              status: { in: ['OPEN', 'PENDING'] },
            },
            select: { id: true, customerServiceWindowExpiresAt: true, unreadCount: true },
          });
        }
      }

      // 3. Message entrant — contrainte unique (channelId, externalMessageId).
      let messageId: string;
      try {
        const message = await tx.message.create({
          data: {
            organizationId: channel.organizationId,
            shopId: channel.shopId,
            conversationId: conversation.id,
            channelId: channel.id,
            contactId: contact.id,
            externalMessageId: event.externalMessageId,
            direction: 'INBOUND',
            // Vrai type conservé ; textContent uniquement pour TEXT.
            type: MESSAGE_TYPE_MAP[messageType] ?? MessageType.UNSUPPORTED,
            status: 'RECEIVED',
            senderType: 'CUSTOMER',
            textContent: messageType === 'TEXT' ? event.text : null,
          },
          select: { id: true },
        });
        messageId = message.id;
      } catch (error) {
        if (isUniqueViolation(error, 'externalMessageId')) {
          // Relivraison : le message existe déjà, aucun compteur à retoucher.
          const existing = await tx.message.findUniqueOrThrow({
            where: {
              channelId_externalMessageId: {
                channelId: channel.id,
                externalMessageId: event.externalMessageId,
              },
            },
            select: { id: true, conversationId: true },
          });
          return {
            organizationId: channel.organizationId,
            shopId: channel.shopId,
            channelId: channel.id,
            contactId: contact.id,
            conversationId: existing.conversationId,
            messageId: existing.id,
            conversationCreated: false,
            created: false,
          };
        }
        throw error;
      }

      // 4. Compteurs + fenêtre 24 h (basée sur le timestamp PROVIDER, jamais
      // réduite par un événement ancien — max des expirations).
      const windowExpiresAt = computeCustomerServiceWindowExpiry({
        providerTimestamp,
        now,
        currentExpiresAt: conversation.customerServiceWindowExpiresAt,
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          unreadCount: { increment: 1 },
          lastMessageAt: now,
          lastInboundMessageAt: now,
          customerServiceWindowExpiresAt: windowExpiresAt,
        },
        select: { id: true },
      });

      return {
        organizationId: channel.organizationId,
        shopId: channel.shopId,
        channelId: channel.id,
        contactId: contact.id,
        conversationId: conversation.id,
        messageId,
        conversationCreated,
        created: true,
      };
    });
  }

  private boundedTimestamp(iso: string, now: Date): Date {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) {
      this.logger.warn(`Timestamp provider illisible (${iso}) — borné à maintenant.`);
      return now;
    }
    return parsed;
  }
}
