import type { OnApplicationShutdown } from '@nestjs/common';
import { Inject, Module } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { AiModule } from '../ai/ai.module';
import { PrismaModule } from '../prisma/prisma.module';
import { InboundProcessingService } from './inbound-processing.service';
import { InboundProcessor } from './inbound.processor';
import { MessageStatusService } from './message-status.service';
import { RealtimeEmitterService } from './realtime-emitter.service';
import { OutboundProcessor } from './outbound.processor';
import { RecoveryService } from './recovery.service';
import { StatusProcessor } from './status.processor';
import {
  INBOUND_QUEUE,
  OUTBOUND_QUEUE,
  STATUS_QUEUE,
  WHATSAPP_WORKER_REDIS,
  whatsappQueueProviders,
} from './whatsapp-queues.providers';
import { WhatsAppProviderFactory } from './whatsapp-provider.factory';

@Module({
  imports: [PrismaModule, AiModule],
  providers: [
    ...whatsappQueueProviders,
    WhatsAppProviderFactory,
    RealtimeEmitterService,
    MessageStatusService,
    InboundProcessingService,
    InboundProcessor,
    OutboundProcessor,
    StatusProcessor,
    RecoveryService,
  ],
  exports: [RecoveryService, RealtimeEmitterService],
})
export class WhatsAppModule implements OnApplicationShutdown {
  constructor(
    @Inject(INBOUND_QUEUE) private readonly inbound: Queue,
    @Inject(OUTBOUND_QUEUE) private readonly outbound: Queue,
    @Inject(STATUS_QUEUE) private readonly status: Queue,
    @Inject(WHATSAPP_WORKER_REDIS) private readonly redis: Redis,
  ) {}

  /** Les Workers sont fermés par leurs OnModuleDestroy ; ici queues + Redis. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.inbound.close(), this.outbound.close(), this.status.close()]);
    this.redis.disconnect();
  }
}
