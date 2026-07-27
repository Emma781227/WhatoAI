import { Injectable, Logger } from '@nestjs/common';
import { SOCKET_EVENTS, statusesFailableFrom, statusesUpgradableTo } from '@whauto/shared';
import type { MessageStatusUpdatedEvent } from '@whauto/shared';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEmitterService } from './realtime-emitter.service';

export interface StatusUpdateInput {
  channelId: string;
  externalMessageId: string;
  status: 'DELIVERED' | 'READ' | 'FAILED';
  providerTimestamp: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface StatusUpdateResult {
  /** false = message sortant encore inconnu (statut orphelin — à réconcilier). */
  messageFound: boolean;
  messageId: string | null;
  conversationId: string | null;
  organizationId: string | null;
  /** false = transition ignorée (déjà appliquée ou interdite) — jamais une erreur. */
  applied: boolean;
  status: 'DELIVERED' | 'READ' | 'FAILED';
}

/**
 * Application centralisée des statuts fournisseur (webhooks réels via la
 * durable inbox ET simulations mock via la queue status). Updates strictement
 * conditionnels (source unique @whauto/shared) : deux événements identiques ou
 * out-of-order ne produisent jamais d'incohérence ni de rétrogradation.
 */
@Injectable()
export class MessageStatusService {
  private readonly logger = new Logger(MessageStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  /**
   * Applique un statut fournisseur. Un providerMessageId encore inconnu N'EST
   * PAS une erreur : le webhook de statut peut devancer l'écriture du Message
   * (ou concerner un envoi d'une autre instance). On renvoie messageFound=false
   * — l'appelant met alors l'événement en WAITING_MESSAGE (réconciliation par
   * le sweep), jamais FAILED (réservé aux vraies erreurs techniques).
   */
  async apply(input: StatusUpdateInput): Promise<StatusUpdateResult> {
    const message = await this.prisma.message.findUnique({
      where: {
        channelId_externalMessageId: {
          channelId: input.channelId,
          externalMessageId: input.externalMessageId,
        },
      },
      select: { id: true, conversationId: true, organizationId: true, shopId: true },
    });
    if (!message) {
      return {
        messageFound: false,
        messageId: null,
        conversationId: null,
        organizationId: null,
        applied: false,
        status: input.status,
      };
    }

    const timestamp = this.boundedTimestamp(input.providerTimestamp);
    let applied = false;

    if (input.status === 'FAILED') {
      const updated = await this.prisma.message.updateMany({
        where: { id: message.id, status: { in: statusesFailableFrom({ providerConfirmed: true }) } },
        data: {
          status: 'FAILED',
          failedAt: timestamp,
          errorCode: input.errorCode ?? 'PROVIDER_FAILED',
          errorMessage: input.errorMessage ?? null,
        },
      });
      applied = updated.count === 1;
    } else {
      const timestampField = input.status === 'DELIVERED' ? 'deliveredAt' : 'readAt';
      const updated = await this.prisma.message.updateMany({
        where: { id: message.id, status: { in: statusesUpgradableTo(input.status) } },
        data: { status: input.status, [timestampField]: timestamp },
      });
      applied = updated.count === 1;

      if (input.status === 'READ') {
        // Sémantique WhatsApp : lu ⇒ délivré. Backfill si DELIVERED n'est
        // jamais arrivé (out-of-order) — sans jamais écraser un deliveredAt.
        await this.prisma.message.updateMany({
          where: { id: message.id, readAt: { not: null }, deliveredAt: null },
          data: { deliveredAt: timestamp },
        });
      }
    }

    if (!applied) {
      this.logger.debug(
        `Transition ${input.status} ignorée pour le message ${message.id} (déjà appliquée ou interdite).`,
      );
    } else {
      await this.emitStatusUpdated(message.id);
    }

    return {
      messageFound: true,
      messageId: message.id,
      conversationId: message.conversationId,
      organizationId: message.organizationId,
      applied,
      status: input.status,
    };
  }

  /**
   * Émet message.status.updated avec l'état RÉEL relu en base (jamais l'entrée).
   * Public : `OutboundProcessor` l'appelle pour ses propres transitions
   * (QUEUED → SENT, → FAILED) — une seule fabrique de payload pour tout le
   * worker, jamais de construction dupliquée.
   */
  async emitStatusUpdated(messageId: string): Promise<void> {
    const row = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        organizationId: true,
        shopId: true,
        conversationId: true,
        clientMessageId: true,
        status: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        failedAt: true,
        errorCode: true,
        errorMessage: true,
      },
    });
    if (!row) {
      return;
    }
    const payload: MessageStatusUpdatedEvent = {
      organizationId: row.organizationId,
      shopId: row.shopId,
      conversationId: row.conversationId,
      messageId: row.id,
      clientMessageId: row.clientMessageId,
      status: row.status,
      sentAt: row.sentAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      readAt: row.readAt?.toISOString() ?? null,
      failedAt: row.failedAt?.toISOString() ?? null,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
    };
    this.realtimeEmitter.emitToOrganization(
      row.organizationId,
      SOCKET_EVENTS.MESSAGE_STATUS_UPDATED,
      payload,
    );
  }

  /** Borne un timestamp fournisseur aberrant (futur) à maintenant. */
  private boundedTimestamp(iso: string): Date {
    const now = new Date();
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() > now.getTime()) {
      return now;
    }
    return parsed;
  }
}
