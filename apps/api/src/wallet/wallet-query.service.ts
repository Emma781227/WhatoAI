import { Injectable } from '@nestjs/common';
import { MAX_CREDITS_PER_AI_RUN } from '@whauto/wallet';

import { PERMISSIONS } from '../common/tenant/permissions';
import type { TenantContext } from '../common/tenant/tenant-context.interface';
import { PrismaService } from '../prisma/prisma.service';
import { TopUpNotFoundError } from '@whauto/wallet';
import type {
  AiUsageEventResponse,
  CreditPackageResponse,
  PagedResponse,
  TopUpResponse,
  WalletResponse,
  WalletTransactionResponse,
} from './dto/wallet.dto';
import { WalletService } from './wallet.service';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Lectures du module Wallet (groupe API) : solde (FORME dépendante du rôle —
 * l'AGENT ne voit que availableCredits + aiAvailable, D7), historiques comptables
 * (ledger + consommation IA), packs et recharges. Toujours tenant-scopé
 * (`organizationId` dans chaque `where`) — jamais de fuite cross-tenant. Aucune
 * clé d'idempotence ni secret n'est sérialisé.
 */
@Injectable()
export class WalletQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  /** Solde. `balance/reserved/status/version` réservés à `wallet.viewLedger`. */
  async getWallet(tenant: TenantContext): Promise<WalletResponse> {
    const wallet = await this.walletService.ensureWallet(tenant.organizationId);
    const base: WalletResponse = {
      availableCredits: wallet.availableCredits,
      aiAvailable: wallet.status === 'ACTIVE' && wallet.availableCredits >= MAX_CREDITS_PER_AI_RUN,
    };
    // Détail comptable UNIQUEMENT pour les rôles habilités (jamais l'AGENT).
    if (tenant.permissions.includes(PERMISSIONS.WALLET_VIEW_LEDGER)) {
      base.balanceCredits = wallet.balanceCredits;
      base.reservedCredits = wallet.reservedCredits;
      base.status = wallet.status;
      base.version = wallet.version;
    }
    return base;
  }

  /** Packs de crédits ACTIFS (catalogue global). Montants autoritaires en base. */
  async listPackages(): Promise<{ items: CreditPackageResponse[] }> {
    const rows = await this.prisma.creditPackage.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { priceMinor: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        priceMinor: true,
        currency: true,
        creditsGranted: true,
        bonusCredits: true,
      },
    });
    return { items: rows };
  }

  /** Ledger (mouvements de crédits) — jamais l'idempotencyKey ni la metadata brute. */
  async listTransactions(
    tenant: TenantContext,
    query: { page?: number; limit?: number },
  ): Promise<PagedResponse<WalletTransactionResponse>> {
    const { page, limit, skip } = paginate(query);
    const where = { organizationId: tenant.organizationId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          type: true,
          direction: true,
          amountCredits: true,
          balanceAfterCredits: true,
          reservedAfterCredits: true,
          referenceType: true,
          referenceId: true,
          descriptionCode: true,
          createdAt: true,
        },
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
      total,
      page,
      limit,
    };
  }

  /** Consommation IA par run (réservé/facturé) — pour justifier chaque débit. */
  async listUsageEvents(
    tenant: TenantContext,
    query: { page?: number; limit?: number },
  ): Promise<PagedResponse<AiUsageEventResponse>> {
    const { page, limit, skip } = paginate(query);
    const where = { organizationId: tenant.organizationId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.aiUsageEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          aiRunId: true,
          status: true,
          creditsReserved: true,
          creditsCharged: true,
          successfulToolCalls: true,
          reasonCode: true,
          createdAt: true,
          completedAt: true,
        },
      }),
      this.prisma.aiUsageEvent.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      })),
      total,
      page,
      limit,
    };
  }

  /** Historique des recharges de l'organisation. */
  async listTopUps(
    tenant: TenantContext,
    query: { page?: number; limit?: number },
  ): Promise<PagedResponse<TopUpResponse>> {
    const { page, limit, skip } = paginate(query);
    const where = { organizationId: tenant.organizationId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.topUp.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: TOPUP_SELECT,
      }),
      this.prisma.topUp.count({ where }),
    ]);
    return { items: rows.map(toTopUpResponse), total, page, limit };
  }

  /** Une recharge (tenant-scopée : 404 anti-énumération si autre org). */
  async getTopUp(tenant: TenantContext, topUpId: string): Promise<TopUpResponse> {
    const row = await this.prisma.topUp.findFirst({
      where: { id: topUpId, organizationId: tenant.organizationId },
      select: TOPUP_SELECT,
    });
    if (!row) {
      throw new TopUpNotFoundError();
    }
    return toTopUpResponse(row);
  }
}

function paginate(query: { page?: number; limit?: number }): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = query.page && query.page > 0 ? query.page : 1;
  const limit = Math.min(query.limit && query.limit > 0 ? query.limit : DEFAULT_LIMIT, MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
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
  paidAt: true,
} satisfies import('@whauto/database').Prisma.TopUpSelect;

function toTopUpResponse(row: {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  creditsGranted: number;
  bonusCredits: number;
  provider: string;
  createdAt: Date;
  paidAt: Date | null;
}): TopUpResponse {
  return {
    id: row.id,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    creditsGranted: row.creditsGranted,
    bonusCredits: row.bonusCredits,
    provider: row.provider,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
  };
}
