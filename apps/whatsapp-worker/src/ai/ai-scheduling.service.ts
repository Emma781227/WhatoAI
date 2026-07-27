import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_QUEUES, aiDebounceJobId } from '@whauto/shared';
import type { AiProcessMessageJobData } from '@whauto/shared';
import type { Queue } from 'bullmq';

import { AI_PROCESS_QUEUE } from '../whatsapp/whatsapp-queues.providers';

/**
 * Planification du job `ai-process-message` avec DEBOUNCE (ajustement 7).
 *
 * Le jobId est keyé par CONVERSATION (`ai.debounce.<conversationId>`, séparateur
 * '.' — BullMQ interdit ':' dans un jobId différé) : tant que le job précédent
 * est encore différé, un nouveau message le REMPLACE pour porter le dernier
 * déclencheur. La publication reste best-effort — si elle échoue (Redis
 * indisponible) le message reste éligible et le sweep de récupération le
 * rattrape (l'autorité d'idempotence est la BASE, jamais Redis).
 */
@Injectable()
export class AiSchedulingService {
  private readonly logger = new Logger(AiSchedulingService.name);

  constructor(
    @Inject(AI_PROCESS_QUEUE) private readonly queue: Queue<AiProcessMessageJobData>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * (Re)planifie la génération pour une conversation. `scheduledAtMs` est
   * injecté (jamais Date.now() implicite) pour rester testable et déterministe.
   */
  async scheduleDebounced(
    data: Omit<AiProcessMessageJobData, 'scheduledAt'>,
    scheduledAtMs: number,
  ): Promise<boolean> {
    const jobId = aiDebounceJobId(data.conversationId);
    const delay = this.configService.get<number>('AI_DEBOUNCE_MS') ?? 3000;
    const payload: AiProcessMessageJobData = {
      ...data,
      scheduledAt: new Date(scheduledAtMs).toISOString(),
    };

    try {
      // Remplace le job différé en attente pour porter le DERNIER déclencheur.
      // remove() est un no-op si le job a déjà été consommé (course couverte
      // par le supersede côté processor et, en dernier ressort, par le sweep).
      await this.queue.remove(jobId).catch(() => undefined);
      await this.queue.add(AI_QUEUES.PROCESS_MESSAGE, payload, {
        jobId,
        delay,
        // Le job terminé disparaît (aucune donnée durable dans Redis) ; un
        // échec est conservé (dead-letter) pour diagnostic. La reprise réelle
        // vient du sweep, pas d'un retry Redis.
        removeOnComplete: true,
        removeOnFail: false,
      });
      return true;
    } catch (error) {
      // Publication perdue : NON bloquant. Le message reste sans AiRun et sera
      // rattrapé par AiRecoveryService dans sa fenêtre bornée.
      this.logger.warn(
        `Planification IA (conversation ${data.conversationId}) échouée — reprise par sweep`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }
}
