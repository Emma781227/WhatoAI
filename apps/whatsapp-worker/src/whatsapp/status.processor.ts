import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { WHATSAPP_QUEUES } from '@whauto/shared';
import type { WhatsAppStatusJobData } from '@whauto/shared';
import type { Job } from 'bullmq';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { MessageStatusService } from './message-status.service';
import { WHATSAPP_WORKER_REDIS } from './whatsapp-queues.providers';

/**
 * Consommateur whatsapp-status : statuts SIMULÉS par le mock (jobs différés).
 * Les statuts de webhooks réels passent par la durable inbox. L'application
 * elle-même est déléguée à MessageStatusService (transitions conditionnelles,
 * idempotence — un job dupliqué est un no-op).
 */
@Injectable()
export class StatusProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatusProcessor.name);
  private worker?: Worker<WhatsAppStatusJobData>;

  constructor(
    private readonly messageStatus: MessageStatusService,
    @Inject(WHATSAPP_WORKER_REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<WhatsAppStatusJobData>(
      WHATSAPP_QUEUES.STATUS,
      (job) => this.process(job),
      { connection: this.redis, concurrency: 5 },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.warn(
        `Job status ${job?.id ?? '?'} en échec (tentative ${job?.attemptsMade ?? '?'}) : ${error.message}`,
      );
    });
  }

  async process(job: Job<WhatsAppStatusJobData>): Promise<void> {
    await this.messageStatus.apply(job.data);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
