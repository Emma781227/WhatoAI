import { Inject, Injectable, Logger } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import { organizationRoom } from '@whauto/shared';
import type { Redis } from 'ioredis';

import { AI_WORKER_REDIS } from '../whatsapp/whatsapp-queues.providers';

/**
 * Émission Socket.IO des événements IA depuis le worker (via Redis pub/sub ; le
 * gateway de l'API relaie). Le module IA a son propre émetteur pour rester
 * indépendant du module WhatsApp (qui l'importe déjà — pas de dépendance
 * circulaire). Fire-and-forget : une émission ne fait jamais échouer un run.
 */
@Injectable()
export class AiRealtimeEmitter {
  private readonly logger = new Logger(AiRealtimeEmitter.name);
  private readonly emitter: Emitter;

  constructor(@Inject(AI_WORKER_REDIS) redis: Redis) {
    this.emitter = new Emitter(redis);
  }

  emitToOrganization(organizationId: string, event: string, payload: unknown): void {
    try {
      this.emitter.to(organizationRoom(organizationId)).emit(event, payload);
    } catch (error) {
      this.logger.warn(`Émission ${event} échouée`, error instanceof Error ? error.message : error);
    }
  }
}
