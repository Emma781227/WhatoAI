import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_QUEUES, WHATSAPP_QUEUES } from '@whauto/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const WHATSAPP_WORKER_REDIS = Symbol('WHATSAPP_WORKER_REDIS');
export const INBOUND_QUEUE = Symbol('INBOUND_QUEUE');
export const OUTBOUND_QUEUE = Symbol('OUTBOUND_QUEUE');
export const STATUS_QUEUE = Symbol('STATUS_QUEUE');

/** Connexion + queue dédiées à l'IA — le module IA est autonome côté Redis. */
export const AI_WORKER_REDIS = Symbol('AI_WORKER_REDIS');
export const AI_PROCESS_QUEUE = Symbol('AI_PROCESS_QUEUE');

/**
 * Producteurs BullMQ du worker : les sweeps de récupération republient vers
 * inbound/outbound, et le processor outbound programme les statuts simulés
 * du mock sur status. Connexion dédiée maxRetriesPerRequest=null (exigence
 * BullMQ) ; les Workers (consommateurs) dupliquent leurs connexions
 * bloquantes à partir de la même instance.
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
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: false,
    },
  });
}

export const whatsappQueueProviders: Provider[] = [
  {
    provide: WHATSAPP_WORKER_REDIS,
    inject: [ConfigService],
    useFactory: (configService: ConfigService): Redis =>
      new Redis(configService.get<string>('REDIS_URL') as string, {
        maxRetriesPerRequest: null,
      }),
  },
  {
    provide: INBOUND_QUEUE,
    inject: [WHATSAPP_WORKER_REDIS, ConfigService],
    useFactory: (redis: Redis, configService: ConfigService) =>
      buildQueue(WHATSAPP_QUEUES.INBOUND, redis, configService),
  },
  {
    provide: OUTBOUND_QUEUE,
    inject: [WHATSAPP_WORKER_REDIS, ConfigService],
    useFactory: (redis: Redis, configService: ConfigService) =>
      buildQueue(WHATSAPP_QUEUES.OUTBOUND, redis, configService),
  },
  {
    provide: STATUS_QUEUE,
    inject: [WHATSAPP_WORKER_REDIS, ConfigService],
    useFactory: (redis: Redis, configService: ConfigService) =>
      buildQueue(WHATSAPP_QUEUES.STATUS, redis, configService),
  },
];

/**
 * Providers de la queue IA — connexion Redis DÉDIÉE (maxRetriesPerRequest=null,
 * comme les queues WhatsApp) pour que le module IA ne dépende pas du module
 * WhatsApp. Une seule instance ioredis partagée entre la Queue (producteur) et
 * le Worker (qui la duplique en interne pour ses connexions bloquantes).
 */
export const aiQueueProviders: Provider[] = [
  {
    provide: AI_WORKER_REDIS,
    inject: [ConfigService],
    useFactory: (configService: ConfigService): Redis =>
      new Redis(configService.get<string>('REDIS_URL') as string, {
        maxRetriesPerRequest: null,
      }),
  },
  {
    provide: AI_PROCESS_QUEUE,
    inject: [AI_WORKER_REDIS, ConfigService],
    useFactory: (redis: Redis, configService: ConfigService) =>
      buildQueue(AI_QUEUES.PROCESS_MESSAGE, redis, configService),
  },
];
