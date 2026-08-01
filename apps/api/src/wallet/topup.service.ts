import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { NotFoundError, SOCKET_EVENTS } from '@whauto/shared';
import { MockPaymentDisabledError, type PaymentSession } from '@whauto/payments';
import {
  canTransitionTopUp,
  CreditPackageInactiveError,
  CreditPackageNotFoundError,
  TopUpInvalidTransitionError,
  TopUpNotFoundError,
  topUpCreditKey,
} from '@whauto/wallet';

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
    return this.prisma.$transaction(async (tx) => {
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
    const result = await this.creditTopUp(topUpId, context);
    // Solde temps réel APRÈS commit, uniquement si un crédit a réellement eu lieu
    // (jamais sur un rejeu idempotent). Best-effort : n'échoue jamais la recharge.
    if (!result.alreadyPaid) {
      const payload = await this.walletService.getBalanceEvent(organizationId);
      if (payload) {
        this.realtime.emitToOrganization(organizationId, SOCKET_EVENTS.WALLET_BALANCE_UPDATED, payload);
      }
    }
    return result;
  }
}

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
