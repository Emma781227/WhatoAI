import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  WhatsAppInboundJobData,
  WhatsAppMessageSendRequestedPayload,
  WhatsAppOutboundJobData,
} from '@whauto/shared';
import type { Queue } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import { INBOUND_QUEUE, OUTBOUND_QUEUE } from './whatsapp-queues.providers';

const SWEEP_BATCH_SIZE = 100;

/**
 * Récupération périodique — la garantie de reprise après panne (API, worker
 * ou Redis) :
 *
 * - durable inbox : les événements RECEIVED (publication manquée), QUEUED
 *   (job perdu — Redis vidé) et PROCESSING (claim orphelin — worker crashé)
 *   plus vieux que la staleness sont republiés ; les FAILED sont retentés
 *   tant que attemptCount < WHATSAPP_JOB_ATTEMPTS ;
 * - transactional outbox : les OutboxEvent PENDING plus vieux que la
 *   staleness sont publiés (jobId = dispatchId → jamais de double envoi
 *   logique, même si l'API avait déjà publié).
 *
 * Tous les jobs sont idempotents : le retraitement est bloqué en base
 * (claims conditionnels, contraintes uniques), pas seulement par les jobIds.
 */
@Injectable()
export class RecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecoveryService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject(INBOUND_QUEUE) private readonly inboundQueue: Queue<WhatsAppInboundJobData>,
    @Inject(OUTBOUND_QUEUE) private readonly outboundQueue: Queue<WhatsAppOutboundJobData>,
  ) {}

  onModuleInit(): void {
    const interval = this.configService.get<number>('WHATSAPP_RECOVERY_SWEEP_INTERVAL_MS') ?? 30000;
    this.timer = setInterval(() => {
      void this.sweep();
    }, interval);
  }

  /** Un seul sweep à la fois ; chaque erreur est loggée sans arrêter le cycle. */
  async sweep(): Promise<{ inboundRecovered: number; outboxRecovered: number }> {
    if (this.running) {
      return { inboundRecovered: 0, outboxRecovered: 0 };
    }
    this.running = true;
    try {
      const [inboundRecovered, outboxRecovered] = await Promise.all([
        this.sweepInboundEvents(),
        this.sweepOutboxEvents(),
      ]);
      if (inboundRecovered > 0 || outboxRecovered > 0) {
        this.logger.log(
          `Sweep de récupération : ${inboundRecovered} événement(s) entrant(s), ${outboxRecovered} outbox republiés.`,
        );
      }
      return { inboundRecovered, outboxRecovered };
    } catch (error) {
      this.logger.error('Échec du sweep de récupération', error);
      return { inboundRecovered: 0, outboxRecovered: 0 };
    } finally {
      this.running = false;
    }
  }

  private stalenessDate(): Date {
    const staleness = this.configService.get<number>('WHATSAPP_RECOVERY_STALENESS_MS') ?? 60000;
    return new Date(Date.now() - staleness);
  }

  private async sweepInboundEvents(): Promise<number> {
    const maxAttempts = this.configService.get<number>('WHATSAPP_JOB_ATTEMPTS') ?? 3;
    const stale = this.stalenessDate();

    // Statuts orphelins définitivement expirés (Message jamais retrouvé) →
    // ORPHANED (terminal, non destructif — jamais FAILED). Basé sur createdAt :
    // l'âge total de l'événement, pas ses re-tentatives.
    const orphanTtl = this.configService.get<number>('WHATSAPP_ORPHAN_STATUS_TTL_MS') ?? 300000;
    await this.prisma.whatsAppInboundEvent.updateMany({
      where: { status: 'WAITING_MESSAGE', createdAt: { lt: new Date(Date.now() - orphanTtl) } },
      data: { status: 'ORPHANED' },
    });

    const events = await this.prisma.whatsAppInboundEvent.findMany({
      where: {
        OR: [
          { status: { in: ['RECEIVED', 'QUEUED', 'PROCESSING'] }, updatedAt: { lt: stale } },
          { status: 'FAILED', attemptCount: { lt: maxAttempts }, updatedAt: { lt: stale } },
          // Statut orphelin encore dans la fenêtre : réconciliation (le Message
          // sortant a pu arriver depuis). Pas de plafond de tentatives ici —
          // c'est l'âge (orphanTtl) qui borne, via le passage ORPHANED ci-dessus.
          { status: 'WAITING_MESSAGE', updatedAt: { lt: stale } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
      select: { id: true, attemptCount: true },
    });

    let recovered = 0;
    for (const event of events) {
      try {
        // jobId versionné par attemptCount : un jobId déjà présent dans Redis
        // (échec conservé) ne bloque pas indéfiniment la récupération.
        // Séparateur '.' : BullMQ interdit ':' dans certains jobIds custom.
        await this.inboundQueue.add(
          'inbound-event',
          { inboundEventId: event.id },
          { jobId: `${event.id}.sweep.${event.attemptCount}` },
        );
        await this.prisma.whatsAppInboundEvent.updateMany({
          where: {
            id: event.id,
            status: { in: ['RECEIVED', 'QUEUED', 'PROCESSING', 'FAILED', 'WAITING_MESSAGE'] },
          },
          data: { status: 'QUEUED', queuedAt: new Date() },
        });
        recovered += 1;
      } catch (error) {
        this.logger.warn(
          `Republication de l'événement entrant ${event.id} échouée`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return recovered;
  }

  private async sweepOutboxEvents(): Promise<number> {
    const stale = this.stalenessDate();

    const events = await this.prisma.outboxEvent.findMany({
      where: { status: 'PENDING', updatedAt: { lt: stale } },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
      select: { id: true, eventType: true, payload: true },
    });

    let recovered = 0;
    for (const event of events) {
      if (event.eventType !== 'WHATSAPP_MESSAGE_SEND_REQUESTED') {
        continue;
      }
      const payload = event.payload as unknown as WhatsAppMessageSendRequestedPayload;
      try {
        await this.outboundQueue.add(
          'send-message',
          { messageId: payload.messageId, dispatchId: payload.dispatchId },
          { jobId: payload.dispatchId },
        );
        await this.prisma.outboxEvent.updateMany({
          where: { id: event.id, status: 'PENDING' },
          data: { status: 'PUBLISHED', publishedAt: new Date(), attemptCount: { increment: 1 } },
        });
        recovered += 1;
      } catch (error) {
        await this.prisma.outboxEvent
          .updateMany({
            where: { id: event.id, status: 'PENDING' },
            data: {
              attemptCount: { increment: 1 },
              lastErrorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            },
          })
          .catch(() => undefined);
        this.logger.warn(`Republication outbox ${event.id} échouée`);
      }
    }
    return recovered;
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
