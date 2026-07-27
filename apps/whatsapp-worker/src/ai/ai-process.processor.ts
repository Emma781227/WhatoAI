import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AI_QUEUES } from '@whauto/shared';
import type { AiProcessMessageJobData } from '@whauto/shared';
import type { Job } from 'bullmq';
import { Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { AI_WORKER_REDIS } from '../whatsapp/whatsapp-queues.providers';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AiTriggerService } from './ai-trigger.service';

/**
 * Consommateur `ai-process-message`. Le job ne porte que des références : la
 * décision (gardes, debounce/supersede, création du run) est prise EN BASE par
 * AiTriggerService. Le processor lui-même est mince et sans état.
 *
 * En sous-phase B (ce groupe), le run est créé en QUEUED : la GÉNÉRATION
 * (appel du provider IA, boucle d'outils, suggestion) est le groupe suivant.
 * Aucune garde ne dépend d'un état Redis : un job rejoué, un doublon ou une
 * reprise par sweep convergent tous vers « un seul run logique par
 * déclencheur » (triggerMessageId unique) et « un seul run actif par
 * conversation » (index partiel).
 */
@Injectable()
export class AiProcessProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiProcessProcessor.name);
  private worker?: Worker<AiProcessMessageJobData>;

  constructor(
    private readonly aiTrigger: AiTriggerService,
    private readonly orchestrator: AiOrchestratorService,
    @Inject(AI_WORKER_REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<AiProcessMessageJobData>(
      AI_QUEUES.PROCESS_MESSAGE,
      (job) => this.process(job),
      { connection: this.redis, concurrency: 3 },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.warn(
        `Job IA ${job?.id ?? '?'} en échec (tentative ${job?.attemptsMade ?? '?'}) : ${error.message}`,
      );
    });
  }

  async process(job: Job<AiProcessMessageJobData>): Promise<void> {
    const result = await this.aiTrigger.processTrigger(job.data);
    // Trace filtrée : jamais de texte client, seulement l'issue de la décision.
    this.logger.debug(
      `IA conversation ${job.data.conversationId} — ${result.outcome}` +
        (result.runId ? ` (run ${result.runId})` : ''),
    );

    // Un run QUEUED (créé, superseded-et-créé, ou déjà existant non traité) est
    // remis en génération. L'orchestrateur claim QUEUED → RUNNING de façon
    // conditionnelle : un run déjà RUNNING/terminal est un no-op (idempotent).
    if (
      result.runId &&
      (result.outcome === 'RUN_CREATED' ||
        result.outcome === 'SUPERSEDED_AND_CREATED' ||
        result.outcome === 'ALREADY_RUN')
    ) {
      await this.orchestrator.runGeneration(result.runId);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
