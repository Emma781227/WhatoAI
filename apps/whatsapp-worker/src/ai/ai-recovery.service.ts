import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AiSchedulingService } from './ai-scheduling.service';

const SWEEP_BATCH_SIZE = 50;

/**
 * Sweep de récupération IA (ajustement 11). Rattrape un message éligible resté
 * SANS AiRun parce que la publication du job de debounce a échoué (Redis
 * indisponible au moment du commit inbound, ou remplacement du job différé
 * perdu dans une course). La base est l'autorité : dès qu'un commit inbound a
 * réussi mais que Redis a « oublié » le job, ce sweep le republie.
 *
 * Deux bornes protègent contre les faux réveils :
 * - FENÊTRE MAXIMALE (`AI_RECOVERY_MAX_MESSAGE_AGE_MS`) : un message plus vieux
 *   n'est JAMAIS ressuscité — on ne répond pas à une conversation abandonnée ;
 * - ÂGE MINIMUM (`AI_RECOVERY_MIN_MESSAGE_AGE_MS`) : on laisse d'abord passer la
 *   fenêtre de debounce, pour ne pas doubler le chemin normal.
 *
 * Ne re-déclenche QUE le dernier message entrant éligible de la conversation :
 * un message ancien ne doit jamais superséder un run porté par un message plus
 * récent. Toutes les autres gardes (IA active, handoff…) sont rejouées par le
 * processor — ce sweep se contente de republier.
 */
@Injectable()
export class AiRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiRecoveryService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly scheduling: AiSchedulingService,
    private readonly orchestrator: AiOrchestratorService,
  ) {}

  onModuleInit(): void {
    const interval = this.configService.get<number>('AI_RECOVERY_SWEEP_INTERVAL_MS') ?? 30000;
    this.timer = setInterval(() => {
      void this.sweep();
    }, interval);
  }

  /** `nowMs` injectable pour des tests déterministes (jamais Date.now() caché). */
  async sweep(nowMs: number = Date.now()): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      // Auto-guérison des runs coincés en QUEUED (job perdu, worker redémarré,
      // erreur transitoire épuisée) AVANT le rattrapage des messages : un run
      // coincé verrouille la conversation (index « un run actif par conv »).
      const rerun = await this.recoverStaleRuns(nowMs);

      const maxAge = this.configService.get<number>('AI_RECOVERY_MAX_MESSAGE_AGE_MS') ?? 600000;
      const minAge = this.configService.get<number>('AI_RECOVERY_MIN_MESSAGE_AGE_MS') ?? 15000;
      const windowStart = new Date(nowMs - maxAge);
      const settleCutoff = new Date(nowMs - minAge);

      // Messages éligibles restés sans run dans la fenêtre : on en tire la
      // liste des conversations à réexaminer (dédupliquées).
      const orphans = await this.prisma.message.findMany({
        where: {
          direction: 'INBOUND',
          senderType: 'CUSTOMER',
          type: 'TEXT',
          createdAt: { gte: windowStart, lte: settleCutoff },
          aiRunTriggered: null,
          channel: { status: 'CONNECTED' },
        },
        orderBy: { createdAt: 'desc' },
        take: SWEEP_BATCH_SIZE,
        select: { conversationId: true },
      });
      const conversationIds = [...new Set(orphans.map((message) => message.conversationId))];

      let recovered = 0;
      for (const conversationId of conversationIds) {
        if (await this.rescheduleConversation(conversationId, windowStart, settleCutoff, nowMs)) {
          recovered += 1;
        }
      }
      if (recovered > 0) {
        this.logger.log(`Sweep IA : ${recovered} conversation(s) republiée(s).`);
      }
      return recovered + rerun;
    } catch (error) {
      this.logger.error('Échec du sweep de récupération IA', error);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Rattrape les runs coincés en QUEUED. Deux cas :
   * - trop vieux (au-delà de la fenêtre `AI_RECOVERY_MAX_MESSAGE_AGE_MS`) : on
   *   abandonne proprement → FAILED, pour ne JAMAIS bloquer la conversation
   *   indéfiniment (l'index « un run actif par conversation » libère la voie) ;
   * - coincés mais encore dans la fenêtre (> `AI_RECOVERY_STALE_RUN_MS`) : on
   *   relance la génération. `runGeneration` claim QUEUED→RUNNING de façon
   *   idempotente ; s'il échoue encore (erreur transitoire), il se relâche en
   *   QUEUED et sera repris au sweep suivant, jusqu'à l'abandon.
   */
  private async recoverStaleRuns(nowMs: number): Promise<number> {
    const staleMs = this.configService.get<number>('AI_RECOVERY_STALE_RUN_MS') ?? 90000;
    const giveUpMs = this.configService.get<number>('AI_RECOVERY_MAX_MESSAGE_AGE_MS') ?? 600000;

    const abandoned = await this.prisma.aiRun.updateMany({
      where: { status: 'QUEUED', createdAt: { lt: new Date(nowMs - giveUpMs) } },
      data: { status: 'FAILED', errorCode: 'AI_RUN_STUCK', completedAt: new Date(nowMs) },
    });
    if (abandoned.count > 0) {
      this.logger.warn(`Sweep IA : ${abandoned.count} run(s) coincé(s) trop vieux → FAILED.`);
    }

    const stale = await this.prisma.aiRun.findMany({
      where: { status: 'QUEUED', createdAt: { lt: new Date(nowMs - staleMs) } },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
      select: { id: true },
    });
    let rerun = 0;
    for (const run of stale) {
      try {
        await this.orchestrator.runGeneration(run.id);
        rerun += 1;
      } catch {
        // runGeneration gère ses propres erreurs ; une relance ratée sera
        // reprise au sweep suivant (jusqu'à l'abandon par âge).
      }
    }
    if (rerun > 0) {
      this.logger.log(`Sweep IA : ${rerun} run(s) coincé(s) relancé(s).`);
    }
    return rerun;
  }

  /**
   * Republie SEULEMENT si le dernier message entrant éligible de la
   * conversation n'a pas de run, est dans la fenêtre, et qu'aucun run n'est
   * déjà actif pour cette conversation.
   */
  private async rescheduleConversation(
    conversationId: string,
    windowStart: Date,
    settleCutoff: Date,
    nowMs: number,
  ): Promise<boolean> {
    const latest = await this.prisma.message.findFirst({
      where: {
        conversationId,
        direction: 'INBOUND',
        senderType: 'CUSTOMER',
        type: 'TEXT',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        organizationId: true,
        shopId: true,
        conversationId: true,
        channelId: true,
        createdAt: true,
        channel: { select: { status: true } },
        aiRunTriggered: { select: { id: true } },
      },
    });
    if (!latest || latest.aiRunTriggered) {
      return false; // Plus de message, ou le plus récent a déjà un run.
    }
    if (latest.channel.status !== 'CONNECTED') {
      return false;
    }
    // Le plus récent doit être dans la fenêtre : ni trop vieux, ni encore chaud.
    if (latest.createdAt < windowStart || latest.createdAt > settleCutoff) {
      return false;
    }
    // Un run déjà actif porte la génération : ne pas le superséder par un sweep.
    const active = await this.prisma.aiRun.findFirst({
      where: {
        conversationId,
        status: { in: ['QUEUED', 'RUNNING', 'WAITING_TOOL'] },
      },
      select: { id: true },
    });
    if (active) {
      return false;
    }

    return this.scheduling.scheduleDebounced(
      {
        organizationId: latest.organizationId,
        shopId: latest.shopId,
        conversationId: latest.conversationId,
        triggerMessageId: latest.id,
        channelId: latest.channelId,
      },
      nowMs,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
