import { Inject, Injectable, Logger } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import { organizationRoom } from '@whauto/shared';
import type { Redis } from 'ioredis';

import { WHATSAPP_WORKER_REDIS } from './whatsapp-queues.providers';

/**
 * Émission Socket.IO depuis le worker via Redis pub/sub : le gateway de
 * l'API (redis-adapter) relaie vers les clients connectés. Fire-and-forget —
 * une émission ne fait jamais échouer un job (PostgreSQL est la source de
 * vérité, les clients se réconcilient à la reconnexion).
 */
@Injectable()
export class RealtimeEmitterService {
  private readonly logger = new Logger(RealtimeEmitterService.name);
  private readonly emitter: Emitter;

  constructor(@Inject(WHATSAPP_WORKER_REDIS) redis: Redis) {
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
