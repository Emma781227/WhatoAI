import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import { InvalidInboundEventError, WhatsAppChannelNotFoundError } from '@whauto/shared';
import type { WhatsAppInboundJobData } from '@whauto/shared';
import type { NormalizedInboundEvent, RawInboundEvent } from '@whauto/whatsapp';
import type { Queue } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';
import { INBOUND_QUEUE } from '../../queues/whatsapp-queues.module';
import { WhatsAppProviderFactory } from './whatsapp-provider.factory';

export interface IngestionResult {
  /** Ids des WhatsAppInboundEvent persistés (nouveaux ou déjà connus). */
  inboundEventIds: string[];
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Durable inbox — pipeline d'entrée de TOUT événement fournisseur (mock
 * aujourd'hui, webhook Meta demain) :
 *
 *   validation provider → normalisation → PERSISTANCE PostgreSQL (RECEIVED)
 *   → ACK HTTP possible → publication BullMQ → marquage QUEUED.
 *
 * L'événement est en base AVANT toute dépendance à Redis : si la publication
 * échoue (Redis indisponible), il reste RECEIVED et le sweep périodique du
 * worker le republiera. Deux livraisons du même webhook = une seule ligne
 * (contrainte unique channelId+externalEventId).
 */
@Injectable()
export class InboundIngestionService {
  private readonly logger = new Logger(InboundIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerFactory: WhatsAppProviderFactory,
    @Inject(INBOUND_QUEUE) private readonly inboundQueue: Queue<WhatsAppInboundJobData>,
  ) {}

  /**
   * Ingestion d'un événement brut pour un canal. Chemin webhook : aucun
   * TenantContext — le canal EST l'autorité (l'organizationId en découle).
   */
  async ingest(channelId: string, rawEvent: RawInboundEvent): Promise<IngestionResult> {
    const channel = await this.prisma.whatsAppChannel.findUnique({
      where: { id: channelId },
      select: { id: true, organizationId: true, provider: true, status: true },
    });
    if (!channel || channel.status === 'DISCONNECTED') {
      throw new WhatsAppChannelNotFoundError();
    }

    const provider = this.providerFactory.getProvider(channel.provider);
    if (!provider.validateInboundEvent(rawEvent)) {
      throw new InvalidInboundEventError('event validation failed');
    }

    let events: NormalizedInboundEvent[];
    try {
      events = provider.parseInboundEvent(rawEvent);
    } catch (error) {
      throw new InvalidInboundEventError(error instanceof Error ? error.message : 'parse error');
    }

    return this.persistAndPublish(channel, events);
  }

  /**
   * Persistance durable + publication d'événements DÉJÀ validés et normalisés.
   * Utilisé par le webhook Meta, qui a déjà fait la vérification HMAC via le
   * provider (autorité cryptographique unique — pas de double validation).
   */
  async persistAndPublish(
    channel: { id: string; organizationId: string },
    events: NormalizedInboundEvent[],
  ): Promise<IngestionResult> {
    const inboundEventIds: string[] = [];
    for (const event of events) {
      const id = await this.persistEvent(channel, event);
      inboundEventIds.push(id);
    }

    // Publication APRÈS persistance — un échec ici ne perd rien (sweep).
    await this.publishEvents(inboundEventIds);

    return { inboundEventIds };
  }

  private async persistEvent(
    channel: { id: string; organizationId: string },
    event: NormalizedInboundEvent,
  ): Promise<string> {
    try {
      const created = await this.prisma.whatsAppInboundEvent.create({
        data: {
          organizationId: channel.organizationId,
          channelId: channel.id,
          externalEventId: event.externalEventId,
          eventKind: event.kind,
          // Payload = événement NORMALISÉ : borné et filtré par construction
          // (jamais de signature, token ou header — voir types provider).
          payload: event as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Relivraison du même webhook : ligne existante, aucune duplication.
        const existing = await this.prisma.whatsAppInboundEvent.findUniqueOrThrow({
          where: {
            channelId_externalEventId: {
              channelId: channel.id,
              externalEventId: event.externalEventId,
            },
          },
          select: { id: true },
        });
        return existing.id;
      }
      throw error;
    }
  }

  /**
   * jobId = inboundEventId : une republication (ingestion doublée, sweep) ne
   * crée jamais un second job actif ; et si le job précédent est déjà terminé
   * et purgé, le processor est de toute façon idempotent (statut PROCESSED en
   * base). Le marquage QUEUED est conditionnel : jamais de retour en arrière
   * depuis PROCESSING/PROCESSED/FAILED.
   */
  private async publishEvents(inboundEventIds: string[]): Promise<void> {
    for (const inboundEventId of inboundEventIds) {
      try {
        await this.inboundQueue.add('inbound-event', { inboundEventId }, { jobId: inboundEventId });
        await this.prisma.whatsAppInboundEvent.updateMany({
          where: { id: inboundEventId, status: 'RECEIVED' },
          data: { status: 'QUEUED', queuedAt: new Date() },
        });
      } catch (error) {
        this.logger.warn(
          `Publication BullMQ échouée pour l'événement entrant ${inboundEventId} — il reste RECEIVED, le sweep le récupérera.`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}
