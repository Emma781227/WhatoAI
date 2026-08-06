import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentStatus } from '@whauto/payments';

import { PrismaService } from '../prisma/prisma.service';
import { PaymentProviderFactory } from './payment-provider.factory';
import { TopUpService } from './topup.service';

const BATCH_SIZE = 50;

/**
 * Reconciliation des paiements (D3). Filet de sécurité pour les webhooks perdus :
 * - rejoue les événements durable inbox coincés en RECEIVED ;
 * - SONDE les TopUp PENDING/PROCESSING trop anciens via `getPaymentStatus`
 *   (vérification SERVEUR = preuve, jamais le returnUrl navigateur) ;
 * - abandonne (EXPIRED) les TopUp jamais finalisés au-delà de la fenêtre.
 *
 * Le CRÉDIT passe TOUJOURS par `TopUpService.applyPaymentOutcome` → `creditTopUp`
 * existant (idempotent) : AUCUNE logique comptable dupliquée. Placé dans l'API
 * (et non le worker) car `creditTopUp` y vit — le réutiliser interdit toute
 * duplication. N'est actif que lorsque Genius Pay est le provider configuré.
 */
@Injectable()
export class PaymentReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentReconciliationService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly providerFactory: PaymentProviderFactory,
    private readonly topUps: TopUpService,
  ) {}

  onModuleInit(): void {
    if (this.providerFactory.get().getProviderName() !== 'GENIUS_PAY') {
      return; // MOCK / autre : aucune reconciliation à planifier.
    }
    const interval = this.config.get<number>('PAYMENT_RECONCILIATION_SWEEP_INTERVAL_MS') ?? 120000;
    this.timer = setInterval(() => void this.sweep(), interval);
  }

  /** `nowMs` injectable pour des tests déterministes. Renvoie le nombre d'items traités. */
  async sweep(nowMs: number = Date.now()): Promise<number> {
    const provider = this.providerFactory.get();
    if (provider.getProviderName() !== 'GENIUS_PAY' || this.running) {
      return 0;
    }
    this.running = true;
    try {
      const minAge = this.config.get<number>('PAYMENT_RECONCILIATION_MIN_AGE_MS') ?? 60000;
      const maxAge = this.config.get<number>('PAYMENT_RECONCILIATION_MAX_AGE_MS') ?? 86400000;
      const staleCutoff = new Date(nowMs - minAge);
      const giveUpCutoff = new Date(nowMs - maxAge);
      let handled = 0;

      // 1. Abandonner les TopUp jamais finalisés au-delà de la fenêtre.
      const expired = await this.prisma.topUp.updateMany({
        where: {
          provider: 'GENIUS_PAY',
          status: { in: ['PENDING', 'PROCESSING'] },
          createdAt: { lt: giveUpCutoff },
        },
        data: { status: 'EXPIRED', expiredAt: new Date(nowMs) },
      });
      handled += expired.count;

      // 2. Rejouer les événements durable inbox coincés RECEIVED.
      const stuck = await this.prisma.paymentWebhookEvent.findMany({
        where: { provider: 'GENIUS_PAY', status: 'RECEIVED', receivedAt: { lt: staleCutoff } },
        take: BATCH_SIZE,
        select: { id: true, normalizedPayload: true },
      });
      for (const event of stuck) {
        const payload = event.normalizedPayload as {
          providerPaymentId?: string;
          status?: PaymentStatus;
          amount?: number | null;
          currency?: string | null;
          reference?: string | null;
        };
        try {
          const result = await this.topUps.applyPaymentOutcome({
            providerPaymentId: payload.providerPaymentId ?? '',
            status: payload.status ?? 'PENDING',
            amount: payload.amount ?? null,
            currency: payload.currency ?? null,
            reference: payload.reference ?? null,
          });
          await this.prisma.paymentWebhookEvent.update({
            where: { id: event.id },
            data: { status: 'PROCESSED', processedAt: new Date(nowMs), lastErrorCode: result.matched ? result.reason : 'TOPUP_NOT_FOUND' },
            select: { id: true },
          });
          handled += 1;
        } catch (error) {
          this.logger.warn(`Rejeu événement paiement ${event.id} échoué : ${errMsg(error)}`);
        }
      }

      // 3. Sonder les TopUp PENDING/PROCESSING dans la fenêtre (webhook probablement perdu).
      const pending = await this.prisma.topUp.findMany({
        where: {
          provider: 'GENIUS_PAY',
          status: { in: ['PENDING', 'PROCESSING'] },
          createdAt: { gte: giveUpCutoff, lt: staleCutoff },
          providerPaymentId: { not: null },
        },
        take: BATCH_SIZE,
        select: { id: true, providerPaymentId: true },
      });
      for (const topUp of pending) {
        try {
          const status = await provider.getPaymentStatus(topUp.providerPaymentId as string);
          await this.topUps.applyPaymentOutcome({
            providerPaymentId: status.providerPaymentId,
            status: status.status,
            amount: status.amount,
            currency: status.currency,
            reference: status.reference,
          });
          handled += 1;
        } catch (error) {
          this.logger.warn(`Sondage TopUp ${topUp.id} échoué : ${errMsg(error)}`);
        }
      }

      if (handled > 0) {
        this.logger.log(`Reconciliation paiements : ${handled} élément(s) traité(s).`);
      }
      return handled;
    } catch (error) {
      this.logger.error('Échec de la reconciliation des paiements', error);
      return 0;
    } finally {
      this.running = false;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
