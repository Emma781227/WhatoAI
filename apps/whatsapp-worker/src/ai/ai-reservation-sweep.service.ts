import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SOCKET_EVENTS } from '@whauto/shared';

import { PrismaService } from '../prisma/prisma.service';
import { AiRealtimeEmitter } from './ai-realtime-emitter.service';
import { WalletReservationService } from '../wallet/wallet-reservation.service';

/**
 * Sweep COMPTABLE des réservations de crédits IA (groupe 5). Filet de sécurité de
 * l'invariant « aucune réservation ACTIVE (AiUsageEvent RESERVED) pour un run
 * TERMINAL ». La finalisation normale est atomique (même transaction que le
 * statut terminal), mais certains chemins terminalisent un run SANS finaliser —
 * notamment le sweep de récupération qui passe en masse des runs coincés à
 * FAILED (`updateMany`). Ce sweep libère alors leur réservation (jamais de
 * facturation ici : réconciliation favorable au marchand).
 *
 * Il ne touche JAMAIS un run encore actif (QUEUED/RUNNING/WAITING_TOOL) : ceux-là
 * relèvent du recovery (relance) puis de la finalisation inline.
 */
const TERMINAL_RUN_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED', 'SUPERSEDED'] as const;
const SWEEP_BATCH_SIZE = 100;

@Injectable()
export class AiReservationSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiReservationSweepService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly walletReservation: WalletReservationService,
    private readonly realtime: AiRealtimeEmitter,
  ) {}

  onModuleInit(): void {
    const interval = this.configService.get<number>('AI_RESERVATION_SWEEP_INTERVAL_MS') ?? 60000;
    this.timer = setInterval(() => {
      void this.sweep();
    }, interval);
  }

  /** Réconcilie un lot de réservations orphelines. Renvoie le nombre libéré. */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const orphans = await this.prisma.aiUsageEvent.findMany({
        where: {
          status: 'RESERVED',
          aiRun: { status: { in: [...TERMINAL_RUN_STATUSES] } },
        },
        orderBy: { createdAt: 'asc' },
        take: SWEEP_BATCH_SIZE,
        select: { aiRunId: true, organizationId: true, walletId: true, shopId: true },
      });

      let released = 0;
      for (const orphan of orphans) {
        try {
          const result = await this.prisma.$transaction((tx) =>
            this.walletReservation.releaseRunReservationInTx(tx, {
              organizationId: orphan.organizationId,
              aiRunId: orphan.aiRunId,
            }),
          );
          if (result.released) {
            released += 1;
            await this.emitBalance(orphan.organizationId, orphan.walletId);
          }
        } catch (error) {
          // Une réservation en échec n'empêche pas les autres — reprise au sweep suivant.
          this.logger.warn(
            `Réconciliation réservation IA (run ${orphan.aiRunId}) échouée : ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (released > 0) {
        this.logger.log(`Sweep comptable IA : ${released} réservation(s) orpheline(s) libérée(s).`);
      }
      return released;
    } catch (error) {
      this.logger.error('Échec du sweep comptable des réservations IA', error);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async emitBalance(organizationId: string, walletId: string): Promise<void> {
    try {
      const payload = await this.walletReservation.buildBalanceEvent(organizationId, walletId);
      if (payload) {
        this.realtime.emitToOrganization(organizationId, SOCKET_EVENTS.WALLET_BALANCE_UPDATED, payload);
      }
    } catch {
      // Best-effort : l'émission ne bloque jamais la réconciliation.
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
