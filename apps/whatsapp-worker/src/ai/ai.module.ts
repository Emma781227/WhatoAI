import type { OnApplicationShutdown } from '@nestjs/common';
import { Inject, Module } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { PrismaModule } from '../prisma/prisma.module';
import {
  AI_PROCESS_QUEUE,
  AI_WORKER_REDIS,
  aiQueueProviders,
} from '../whatsapp/whatsapp-queues.providers';
import { AiContextService } from './ai-context.service';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AiOutboundSenderService } from './ai-outbound-sender.service';
import { AiProcessProcessor } from './ai-process.processor';
import { AiProviderFactory } from './ai-provider.factory';
import { AiRealtimeEmitter } from './ai-realtime-emitter.service';
import { AiRecoveryService } from './ai-recovery.service';
import { AiReservationSweepService } from './ai-reservation-sweep.service';
import { AiSchedulingService } from './ai-scheduling.service';
import { AiSummaryService } from './ai-summary.service';
import { AiTriggerService } from './ai-trigger.service';
import { AiToolExecutor } from './tools/tool-executor';
import { WalletReservationService } from '../wallet/wallet-reservation.service';

/**
 * Orchestration IA (sous-phase B — déclenchement/debounce/supersede/sweep).
 * La GÉNÉRATION (provider IA, outils, suggestion) arrivera dans un module
 * séparé au groupe suivant. `AiSchedulingService` est exporté pour que
 * l'InboundProcessor (module WhatsApp) planifie après le commit inbound.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    ...aiQueueProviders,
    WalletReservationService,
    AiTriggerService,
    AiSchedulingService,
    AiProcessProcessor,
    AiRecoveryService,
    AiReservationSweepService,
    AiToolExecutor,
    AiContextService,
    AiSummaryService,
    AiProviderFactory,
    AiRealtimeEmitter,
    AiOrchestratorService,
    AiOutboundSenderService,
  ],
  exports: [AiSchedulingService, AiToolExecutor, AiOrchestratorService, AiOutboundSenderService],
})
export class AiModule implements OnApplicationShutdown {
  constructor(
    @Inject(AI_PROCESS_QUEUE) private readonly queue: Queue,
    @Inject(AI_WORKER_REDIS) private readonly redis: Redis,
  ) {}

  /** Le Worker est fermé par son OnModuleDestroy ; ici la queue + Redis. */
  async onApplicationShutdown(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    this.redis.disconnect();
  }
}
