import type { OnApplicationShutdown } from '@nestjs/common';
import { Inject, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_QUEUES, WHATSAPP_QUEUES } from '@whauto/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const WHATSAPP_QUEUE_REDIS = Symbol('WHATSAPP_QUEUE_REDIS');
export const INBOUND_QUEUE = Symbol('INBOUND_QUEUE');
export const OUTBOUND_QUEUE = Symbol('OUTBOUND_QUEUE');
export const STATUS_QUEUE = Symbol('STATUS_QUEUE');
export const AI_PROCESS_QUEUE = Symbol('AI_PROCESS_QUEUE');

/**
 * Producteurs BullMQ de l'API (le worker consomme). Connexion Redis DÉDIÉE :
 * BullMQ exige maxRetriesPerRequest=null, incompatible avec le client partagé
 * du rate limiting. Les options de jobs (attempts/backoff) sont posées par
 * queue : tout producteur (endpoint, publisher outbox, sweep) hérite des mêmes.
 */
function buildQueue(name: string, connection: Redis, configService: ConfigService): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: configService.get<number>('WHATSAPP_JOB_ATTEMPTS') ?? 3,
      backoff: {
        type: 'exponential',
        delay: configService.get<number>('WHATSAPP_JOB_BACKOFF_MS') ?? 2000,
      },
      // Les jobs réussis sont purgés (1 h / 1000 max) ; les échecs définitifs
      // sont CONSERVÉS dans Redis (dead-letter naturelle BullMQ, inspectable)
      // — la vérité durable reste PostgreSQL (inbox/outbox).
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: false,
    },
  });
}

@Module({
  providers: [
    {
      provide: WHATSAPP_QUEUE_REDIS,
      inject: [ConfigService],
      useFactory: (configService: ConfigService): Redis =>
        new Redis(configService.get<string>('REDIS_URL') as string, {
          maxRetriesPerRequest: null,
        }),
    },
    {
      provide: INBOUND_QUEUE,
      inject: [WHATSAPP_QUEUE_REDIS, ConfigService],
      useFactory: (redis: Redis, configService: ConfigService) =>
        buildQueue(WHATSAPP_QUEUES.INBOUND, redis, configService),
    },
    {
      provide: OUTBOUND_QUEUE,
      inject: [WHATSAPP_QUEUE_REDIS, ConfigService],
      useFactory: (redis: Redis, configService: ConfigService) =>
        buildQueue(WHATSAPP_QUEUES.OUTBOUND, redis, configService),
    },
    {
      provide: STATUS_QUEUE,
      inject: [WHATSAPP_QUEUE_REDIS, ConfigService],
      useFactory: (redis: Redis, configService: ConfigService) =>
        buildQueue(WHATSAPP_QUEUES.STATUS, redis, configService),
    },
    {
      provide: AI_PROCESS_QUEUE,
      inject: [WHATSAPP_QUEUE_REDIS, ConfigService],
      useFactory: (redis: Redis, configService: ConfigService) =>
        buildQueue(AI_QUEUES.PROCESS_MESSAGE, redis, configService),
    },
  ],
  exports: [INBOUND_QUEUE, OUTBOUND_QUEUE, STATUS_QUEUE, AI_PROCESS_QUEUE],
})
export class WhatsAppQueuesModule implements OnApplicationShutdown {
  constructor(
    @Inject(INBOUND_QUEUE) private readonly inbound: Queue,
    @Inject(OUTBOUND_QUEUE) private readonly outbound: Queue,
    @Inject(STATUS_QUEUE) private readonly status: Queue,
    @Inject(AI_PROCESS_QUEUE) private readonly aiProcess: Queue,
    @Inject(WHATSAPP_QUEUE_REDIS) private readonly redis: Redis,
  ) {}

  /** Indispensable pour que app.close() libère Redis (sinon les e2e ne terminent pas). */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([
      this.inbound.close(),
      this.outbound.close(),
      this.status.close(),
      this.aiProcess.close(),
    ]);
    this.redis.disconnect();
  }
}
