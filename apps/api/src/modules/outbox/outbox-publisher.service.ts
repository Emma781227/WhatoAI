import { Inject, Injectable, Logger } from '@nestjs/common';
import type { WhatsAppMessageSendRequestedPayload, WhatsAppOutboundJobData } from '@whauto/shared';
import type { Queue } from 'bullmq';

import { PrismaService } from '../../prisma/prisma.service';
import { OUTBOUND_QUEUE } from '../../queues/whatsapp-queues.module';

/**
 * Publisher du transactional outbox, côté API (chemin rapide post-commit).
 * Best-effort : si Redis est indisponible, l'OutboxEvent reste PENDING et le
 * sweep périodique du worker le publiera — un message sortant n'est jamais
 * définitivement bloqué. jobId = dispatchId : publier deux fois le même
 * OutboxEvent ne crée jamais un second envoi logique.
 */
@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OUTBOUND_QUEUE) private readonly outboundQueue: Queue<WhatsAppOutboundJobData>,
  ) {}

  async tryPublish(outboxEventId: string): Promise<void> {
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
        `Publication outbox ${event.id} échouée (reste PENDING, le sweep la reprendra) : ${message}`,
      );
      await this.prisma.outboxEvent
        .updateMany({
          where: { id: event.id, status: 'PENDING' },
          data: { attemptCount: { increment: 1 }, lastErrorMessage: message.slice(0, 500) },
        })
        .catch(() => undefined);
    }
  }
}
