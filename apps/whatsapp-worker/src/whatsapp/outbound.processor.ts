import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isCustomerServiceWindowOpen,
  statusesFailableFrom,
  statusesUpgradableTo,
  WHATSAPP_QUEUES,
} from '@whauto/shared';
import type { WhatsAppOutboundJobData, WhatsAppStatusJobData } from '@whauto/shared';
import { MockWhatsAppProvider, WhatsAppProviderSendError } from '@whauto/whatsapp';
import type { Job, Queue } from 'bullmq';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { PrismaService } from '../prisma/prisma.service';
import { MessageStatusService } from './message-status.service';
import { OUTBOUND_QUEUE, STATUS_QUEUE, WHATSAPP_WORKER_REDIS } from './whatsapp-queues.providers';
import { WhatsAppProviderFactory } from './whatsapp-provider.factory';

/**
 * Consommateur whatsapp-outbound. Gestion des retries BullMQ (validée) :
 * - PENDING → QUEUED puis envoi ;
 * - QUEUED → nouvelle tentative AUTORISÉE (jamais d'échec parce que le
 *   message est "déjà QUEUED" — c'est précisément le cas d'un retry) ;
 * - SENT/DELIVERED/READ → job déjà traité, succès silencieux ;
 * - FAILED → uniquement l'endpoint retry explicite (nouveau dispatchId).
 *
 * Risque documenté : si l'envoi provider réussit mais que la réponse réseau
 * est perdue avant l'écriture SENT, la tentative suivante RENVERRA le message
 * (duplication chez le destinataire). Meta ne fournit aucune idempotence
 * externe dans cette phase — dispatchId/attemptCount/lastAttemptAt tracent
 * précisément chaque tentative pour le diagnostic.
 */
@Injectable()
export class OutboundProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundProcessor.name);
  private worker?: Worker<WhatsAppOutboundJobData>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerFactory: WhatsAppProviderFactory,
    private readonly configService: ConfigService,
    @Inject(WHATSAPP_WORKER_REDIS) private readonly redis: Redis,
    @Inject(STATUS_QUEUE) private readonly statusQueue: Queue<WhatsAppStatusJobData>,
    @Inject(OUTBOUND_QUEUE) private readonly outboundQueue: Queue<WhatsAppOutboundJobData>,
    private readonly messageStatus: MessageStatusService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<WhatsAppOutboundJobData>(
      WHATSAPP_QUEUES.OUTBOUND,
      (job) => this.process(job),
      { connection: this.redis, concurrency: 5 },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.warn(
        `Job outbound ${job?.id ?? '?'} en échec (tentative ${job?.attemptsMade ?? '?'}) : ${error.message}`,
      );
    });
  }

  async process(job: Job<WhatsAppOutboundJobData>): Promise<void> {
    const { messageId, dispatchId } = job.data;

    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        status: true,
        dispatchId: true,
        textContent: true,
        channelId: true,
        conversation: {
          select: { id: true, customerServiceWindowExpiresAt: true },
        },
        channel: { select: { id: true, provider: true, status: true, phoneNumber: true } },
        contact: { select: { normalizedPhone: true } },
      },
    });
    if (!message) {
      this.logger.error(`Message sortant introuvable: ${messageId}`);
      return;
    }
    if (message.dispatchId !== dispatchId) {
      // Un retry explicite a créé un nouveau cycle d'envoi : ce job est périmé.
      return;
    }
    if (message.status === 'SENT' || message.status === 'DELIVERED' || message.status === 'READ') {
      return; // Déjà traité.
    }
    if (message.status === 'FAILED' || message.status === 'RECEIVED') {
      return; // FAILED → retry explicite uniquement ; RECEIVED n'est pas sortant.
    }

    // PENDING → QUEUED ; un message déjà QUEUED (retry BullMQ) continue tel quel.
    await this.prisma.message.updateMany({
      where: { id: message.id, status: 'PENDING' },
      data: { status: 'QUEUED' },
    });

    // Autorité finale sur la fenêtre 24 h, au moment réel de l'envoi.
    if (
      !isCustomerServiceWindowOpen(message.conversation.customerServiceWindowExpiresAt, new Date())
    ) {
      await this.markFailed(message.id, 'CUSTOMER_SERVICE_WINDOW_EXPIRED', 'The 24-hour customer service window has expired.');
      return; // Échec déterministe : inutile de retenter.
    }
    if (message.channel.status !== 'CONNECTED') {
      await this.markFailed(message.id, 'CHANNEL_NOT_CONNECTED', 'The WhatsApp channel is not connected.');
      return;
    }

    const provider = this.providerFactory.getProvider(message.channel.provider);

    // Trace de tentative AVANT l'appel externe (diagnostic des réponses perdues).
    await this.prisma.message.updateMany({
      where: { id: message.id },
      data: { attemptCount: { increment: 1 }, lastAttemptAt: new Date() },
    });

    let externalMessageId: string;
    try {
      const result = await provider.sendTextMessage({
        channel: { id: message.channel.id, phoneNumber: message.channel.phoneNumber },
        to: message.contact.normalizedPhone,
        text: message.textContent ?? '',
        dispatchId,
      });
      externalMessageId = result.externalMessageId;
    } catch (error) {
      const code = error instanceof WhatsAppProviderSendError ? error.code : 'PROVIDER_SEND_ERROR';
      const detail = error instanceof Error ? error.message : String(error);
      // Une erreur DÉFINITIVE (numéro/payload invalide, token, fenêtre fermée)
      // ne doit jamais être retentée en boucle : FAILED immédiat.
      const isDefinitive =
        error instanceof WhatsAppProviderSendError && error.errorClass !== 'RETRYABLE';
      const attempts = job.opts.attempts ?? this.configService.get<number>('WHATSAPP_JOB_ATTEMPTS') ?? 3;
      const isLastAttempt = job.attemptsMade + 1 >= attempts;
      if (isDefinitive || isLastAttempt) {
        await this.markFailed(message.id, code, detail);
        return; // FAILED, le job se termine proprement.
      }
      throw error; // Erreur transitoire : BullMQ retente avec backoff.
    }

    // QUEUED → SENT + externalMessageId (conditionnel : jamais de rétrogradation).
    const sent = await this.prisma.message.updateMany({
      where: { id: message.id, status: { in: statusesUpgradableTo('SENT') } },
      data: { status: 'SENT', sentAt: new Date(), externalMessageId },
    });

    // Le ✓ « envoyé » de l'UI : sans cette émission le message reste sur
    // l'horloge jusqu'au DELIVERED de Meta. Gardé sur count === 1 — pas de
    // transition réelle, pas d'événement (même règle que MessageStatusService).
    if (sent.count === 1) {
      await this.messageStatus.emitStatusUpdated(message.id);
    }

    // Simulation mock : programme DELIVERED puis READ en jobs différés.
    // ⚠️ BullMQ interdit ':' dans le jobId d'un job DIFFÉRÉ ("Custom Id
    // cannot contain :") — séparateur '.' obligatoire ici.
    if (provider instanceof MockWhatsAppProvider) {
      for (const step of provider.simulatedStatusPlan()) {
        await this.statusQueue.add(
          'simulated-status',
          {
            channelId: message.channelId,
            externalMessageId,
            status: step.status,
            providerTimestamp: new Date(Date.now() + step.delayMs).toISOString(),
          },
          { delay: step.delayMs, jobId: `${externalMessageId}.${step.status}` },
        );
      }
    }
  }

  private async markFailed(messageId: string, errorCode: string, errorMessage: string): Promise<void> {
    const failed = await this.prisma.message.updateMany({
      where: { id: messageId, status: { in: statusesFailableFrom() } },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        errorCode,
        errorMessage: errorMessage.slice(0, 500),
      },
    });

    // Un échec d'envoi doit remonter à l'agent en temps réel (alerte + bouton
    // renvoyer), pas rester silencieusement sur l'horloge.
    if (failed.count === 1) {
      await this.messageStatus.emitStatusUpdated(messageId);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
