import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { NotFoundError, SOCKET_EVENTS } from '@whauto/shared';
import {
  checkPaymentAmount,
  MockPaymentDisabledError,
  type PaymentSession,
  type PaymentStatus,
} from '@whauto/payments';
import {
  canTransitionTopUp,
  CreditPackageInactiveError,
  CreditPackageNotFoundError,
  TopUpInvalidTransitionError,
  TopUpNotFoundError,
  topUpCreditKey,
} from '@whauto/wallet';
import type { TopUpStatus } from '@whauto/database';

import { PrismaService } from '../prisma/prisma.service';
import type { AuditActionContext } from '../modules/organizations/organization-audit.service';
import { OrganizationAuditService } from '../modules/organizations/organization-audit.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PaymentProviderFactory } from './payment-provider.factory';
import { WalletService } from './wallet.service';

export interface TopUpPublic {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  creditsGranted: number;
  bonusCredits: number;
  provider: string;
  createdAt: string;
}

export interface CreditResult {
  topUpId: string;
  status: string;
  alreadyPaid: boolean;
  balanceAfterCredits: number;
}

/**
 * Recharge (TopUp) : créer une intention de paiement, puis créditer le Wallet à
 * la confirmation. L'agrégateur ENCAISSE (via PaymentProvider) ; le Wallet gère
 * les crédits. Les montants/crédits sont FIGÉS à la création depuis le pack
 * autoritaire. Le crédit du Wallet est IDEMPOTENT (clé `topup:credit:{id}` + un
 * TopUp PAID n'est jamais recrédité) — aucun double crédit sur webhook/rejeu.
 *
 * Ce groupe fournit la LOGIQUE (créer / créditer) ; les endpoints, permissions
 * et realtime viennent au groupe API.
 */
@Injectable()
export class TopUpService {
  private readonly logger = new Logger(TopUpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly audit: OrganizationAuditService,
    private readonly payments: PaymentProviderFactory,
    private readonly realtime: RealtimeService,
  ) {}

  /** Crée un TopUp PENDING (valeurs figées) + ouvre une session de paiement. */
  async createTopUp(
    organizationId: string,
    userId: string,
    creditPackageId: string,
    context: AuditActionContext,
  ): Promise<{ topUp: TopUpPublic; paymentSession: PaymentSession }> {
    const pkg = await this.prisma.creditPackage.findUnique({ where: { id: creditPackageId } });
    if (!pkg) {
      throw new CreditPackageNotFoundError();
    }
    if (!pkg.isActive) {
      throw new CreditPackageInactiveError();
    }

    const wallet = await this.walletService.ensureWallet(organizationId);
    const provider = this.payments.get();
    const providerName = provider.getProviderName();

    const topUp = await this.prisma.$transaction(async (tx) => {
      const created = await tx.topUp.create({
        data: {
          organizationId,
          walletId: wallet.id,
          creditPackageId,
          provider: providerName,
          status: 'PENDING',
          amountMinor: pkg.priceMinor,
          currency: pkg.currency,
          creditsGranted: pkg.creditsGranted,
          bonusCredits: pkg.bonusCredits,
          idempotencyKey: randomUUID(),
          initiatedByUserId: userId,
        },
        select: TOPUP_SELECT,
      });
      await this.audit.record(
        {
          organizationId,
          eventType: 'TOPUP_CREATED',
          actorUserId: userId,
          metadata: { topUpId: created.id, creditPackageId, amountMinor: pkg.priceMinor },
          context,
        },
        tx,
      );
      return created;
    });

    // Appel EXTERNE hors transaction (session de paiement chez l'agrégateur).
    const paymentSession = await provider.createPayment({
      reference: topUp.id,
      amountMinor: topUp.amountMinor,
      currency: topUp.currency,
      description: pkg.name,
    });

    await this.prisma.topUp.update({
      where: { id: topUp.id },
      data: {
        providerPaymentId: paymentSession.providerPaymentId,
        providerReference: paymentSession.reference,
      },
      select: { id: true },
    });

    return { topUp: toTopUpPublic(topUp), paymentSession };
  }

  /**
   * Crédite le Wallet à la confirmation d'un paiement. ATOMIQUE et IDEMPOTENT :
   * verrou du TopUp, un TopUp déjà PAID est un no-op, sinon crédit du Wallet
   * (clé unique par TopUp) + transition PAID + audits — le tout dans une seule
   * transaction. Un webhook/confirmation rejoué ne crédite jamais deux fois.
   */
  async creditTopUp(topUpId: string, context: AuditActionContext): Promise<CreditResult> {
    let organizationId: string | null = null;
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM topups WHERE id = ${topUpId} FOR UPDATE`;
      const topUp = await tx.topUp.findUnique({
        where: { id: topUpId },
        select: {
          id: true,
          organizationId: true,
          walletId: true,
          status: true,
          creditsGranted: true,
          bonusCredits: true,
          initiatedByUserId: true,
          wallet: { select: { balanceCredits: true } },
        },
      });
      if (!topUp) {
        throw new TopUpNotFoundError();
      }
      organizationId = topUp.organizationId;
      if (topUp.status === 'PAID') {
        // Déjà crédité : no-op idempotent (jamais un second crédit).
        return {
          topUpId,
          status: 'PAID',
          alreadyPaid: true,
          balanceAfterCredits: topUp.wallet.balanceCredits,
        };
      }
      if (!canTransitionTopUp(topUp.status, 'PAID')) {
        throw new TopUpInvalidTransitionError(topUp.status, 'PAID');
      }

      const totalCredits = topUp.creditsGranted + topUp.bonusCredits;
      const movement = await this.walletService.applyMovementInTx(tx, {
        walletId: topUp.walletId,
        organizationId: topUp.organizationId,
        type: 'CREDIT_PURCHASE',
        direction: 'CREDIT',
        amountCredits: totalCredits,
        referenceType: 'TOPUP',
        referenceId: topUpId,
        idempotencyKey: topUpCreditKey(topUpId),
        descriptionCode: 'TOPUP_PAID',
        createdByUserId: topUp.initiatedByUserId,
      });

      await tx.topUp.update({
        where: { id: topUpId },
        data: { status: 'PAID', paidAt: new Date() },
        select: { id: true },
      });

      await this.audit.record(
        {
          organizationId: topUp.organizationId,
          eventType: 'TOPUP_PAID',
          metadata: { topUpId, creditsGranted: totalCredits, walletTransactionId: movement.walletTransactionId },
          context,
        },
        tx,
      );
      await this.audit.record(
        {
          organizationId: topUp.organizationId,
          eventType: 'WALLET_CREDITED',
          metadata: {
            topUpId,
            walletTransactionId: movement.walletTransactionId,
            amountCredits: totalCredits,
            balanceAfter: movement.balanceAfterCredits,
          },
          context,
        },
        tx,
      );

      return {
        topUpId,
        status: 'PAID',
        alreadyPaid: false,
        balanceAfterCredits: movement.balanceAfterCredits,
      };
    });

    // Émission APRÈS commit, uniquement sur un crédit RÉEL (jamais sur rejeu) —
    // source UNIQUE du temps réel pour tous les chemins de crédit (webhook, mock,
    // reconciliation). Si le Wallet était insuffisant, l'IA redevient éligible
    // automatiquement (le prochain AiRun revérifie le solde) — aucun replay ici.
    if (!result.alreadyPaid && organizationId) {
      await this.emitBalance(organizationId);
    }
    return result;
  }

  /**
   * Confirmation MOCK (dev/test/staging autorisé uniquement). Vérifie que le
   * TopUp appartient à l'organisation (404 anti-énumération sinon), puis crédite.
   * JAMAIS active silencieusement en production (garde `allowMockPayments`).
   */
  async mockConfirm(
    organizationId: string,
    topUpId: string,
    context: AuditActionContext,
  ): Promise<CreditResult> {
    if (!this.payments.allowMockPayments()) {
      throw new MockPaymentDisabledError();
    }
    const owned = await this.prisma.topUp.findFirst({
      where: { id: topUpId, organizationId },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundError('Top-up not found.');
    }
    // creditTopUp émet lui-même wallet.balance.updated sur un crédit réel.
    return this.creditTopUp(topUpId, context);
  }

  /**
   * APPLIQUE une issue de paiement (webhook vérifié OU vérification serveur de
   * reconciliation) au TopUp figé. Résout le TopUp par `providerPaymentId` puis
   * par `reference` (metadata = notre id). Idempotent.
   * - `PAID` : CONTRÔLE montant/devise vs TopUp figé (D4) — match → `creditTopUp`
   *   existant (JAMAIS de logique comptable dupliquée) ; incohérence → JAMAIS de
   *   crédit, TopUp `REVIEW_REQUIRED` + `failureCode`, aucun frontend ne peut forcer ;
   * - `FAILED/CANCELLED/EXPIRED/REFUNDED/PROCESSING` : transition conditionnelle,
   *   aucun crédit.
   */
  async applyPaymentOutcome(outcome: {
    providerPaymentId: string;
    status: PaymentStatus;
    amount: number | null;
    currency: string | null;
    reference: string | null;
  }): Promise<PaymentOutcomeResult> {
    const topUp = await this.resolveTopUp(outcome.providerPaymentId, outcome.reference);
    if (!topUp) {
      return { matched: false, action: 'NOT_FOUND', topUpId: null, reason: null };
    }
    const context: AuditActionContext = { userAgent: 'payment-webhook' };

    if (outcome.status === 'PAID') {
      const check = checkPaymentAmount({
        topUpAmountMinor: topUp.amountMinor,
        topUpCurrency: topUp.currency,
        providerAmount: outcome.amount,
        providerCurrency: outcome.currency,
      });
      if (!check.ok) {
        // D4 : `completed` mais montant/devise ≠ figé → JAMAIS crédité, revue manuelle.
        const reason = check.reason === 'CURRENCY_MISMATCH' ? 'PAYMENT_CURRENCY_MISMATCH' : 'PAYMENT_AMOUNT_MISMATCH';
        await this.transitionTopUp(topUp.id, 'REVIEW_REQUIRED', reason);
        this.logger.warn(`TopUp ${topUp.id} en revue (${reason}) — aucun crédit.`);
        return { matched: true, action: 'REVIEW_REQUIRED', topUpId: topUp.id, reason };
      }
      const result = await this.creditTopUp(topUp.id, context);
      return {
        matched: true,
        action: result.alreadyPaid ? 'ALREADY_PAID' : 'CREDITED',
        topUpId: topUp.id,
        reason: null,
      };
    }

    // Statuts non facturables → transition conditionnelle (idempotente).
    const target = PAYMENT_STATUS_TO_TOPUP[outcome.status];
    if (target && canTransitionTopUp(topUp.status as TopUpStatus, target)) {
      await this.transitionTopUp(topUp.id, target, null);
      return { matched: true, action: 'TRANSITIONED', topUpId: topUp.id, reason: null };
    }
    return { matched: true, action: 'NOOP', topUpId: topUp.id, reason: null };
  }

  // ------------------------------------------------------------------ helpers

  /** Résout le TopUp par identifiant provider puis par notre référence (metadata). */
  private async resolveTopUp(providerPaymentId: string, reference: string | null) {
    const or: Array<Record<string, string>> = [];
    if (providerPaymentId) or.push({ providerPaymentId });
    if (reference) or.push({ id: reference });
    if (or.length === 0) return null;
    return this.prisma.topUp.findFirst({
      where: { OR: or },
      select: { id: true, status: true, amountMinor: true, currency: true },
    });
  }

  /** Transition conditionnelle de statut TopUp (jamais depuis un état terminal incompatible). */
  private async transitionTopUp(
    topUpId: string,
    to: TopUpStatus,
    failureCode: string | null,
  ): Promise<void> {
    const current = await this.prisma.topUp.findUnique({
      where: { id: topUpId },
      select: { status: true },
    });
    if (!current || !canTransitionTopUp(current.status as TopUpStatus, to)) {
      return; // Transition invalide / déjà appliquée : no-op idempotent.
    }
    await this.prisma.topUp.updateMany({
      where: { id: topUpId, status: current.status },
      data: {
        status: to,
        ...(failureCode ? { failureCode } : {}),
        ...(to === 'FAILED' ? { failedAt: new Date() } : {}),
        ...(to === 'EXPIRED' ? { expiredAt: new Date() } : {}),
      },
    });
  }

  private async emitBalance(organizationId: string): Promise<void> {
    try {
      const payload = await this.walletService.getBalanceEvent(organizationId);
      if (payload) {
        this.realtime.emitToOrganization(organizationId, SOCKET_EVENTS.WALLET_BALANCE_UPDATED, payload);
      }
    } catch (error) {
      this.logger.warn(
        `Émission solde post-crédit échouée : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Résultat de l'application d'une issue de paiement (diagnostic, jamais de secret). */
export interface PaymentOutcomeResult {
  matched: boolean;
  action: 'CREDITED' | 'ALREADY_PAID' | 'REVIEW_REQUIRED' | 'TRANSITIONED' | 'NOOP' | 'NOT_FOUND';
  topUpId: string | null;
  reason: string | null;
}

/** Statuts de paiement NON facturables → statut TopUp cible. `PAID` est traité à part (crédit). */
const PAYMENT_STATUS_TO_TOPUP: Partial<Record<PaymentStatus, TopUpStatus>> = {
  PROCESSING: 'PROCESSING',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  REFUNDED: 'REFUNDED',
};

const TOPUP_SELECT = {
  id: true,
  status: true,
  amountMinor: true,
  currency: true,
  creditsGranted: true,
  bonusCredits: true,
  provider: true,
  createdAt: true,
} satisfies import('@whauto/database').Prisma.TopUpSelect;

function toTopUpPublic(row: {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  creditsGranted: number;
  bonusCredits: number;
  provider: string;
  createdAt: Date;
}): TopUpPublic {
  return {
    id: row.id,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    creditsGranted: row.creditsGranted,
    bonusCredits: row.bonusCredits,
    provider: row.provider,
    createdAt: row.createdAt.toISOString(),
  };
}
