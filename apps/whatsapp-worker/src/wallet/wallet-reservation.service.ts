import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import type { WalletRealtimeEvent } from '@whauto/shared';
import {
  aiUsageDebitKey,
  aiUsageReleaseKey,
  aiUsageReservationKey,
  availableCredits,
  computeAiRunCredits,
  computeBalancesAfter,
  isTypeDirectionValid,
  MAX_CREDITS_PER_AI_RUN,
  WalletClosedError,
  WalletInvariantViolationError,
  WalletNotFoundError,
  WalletSuspendedError,
  type AiRunBillableOutcome,
  type WalletStatus,
  type WalletTransactionDirection,
  type WalletTransactionType,
} from '@whauto/wallet';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Réservation / libération de crédits IA CÔTÉ WORKER (groupe 4). Les writes
 * Prisma vivent dans les apps (l'architecture interdit Prisma dans les packages)
 * — la SOURCE DE VÉRITÉ reste les primitives PURES de `@whauto/wallet`
 * (`computeBalancesAfter`, `isTypeDirectionValid`, clés d'idempotence, plafond),
 * exactement comme les transitions Message partagées entre API et worker. Ce
 * service ne fait PAS le débit final ni le sweep (groupe 5) : uniquement
 * RESERVE (+3, balance inchangée) et RELEASE (reliquat) idempotents.
 */

export type PrismaTransaction = Prisma.TransactionClient;

/** Instantané d'un Wallet verrouillé (le disponible est TOUJOURS dérivé). */
export interface LockedWallet {
  balanceCredits: number;
  reservedCredits: number;
  status: WalletStatus;
  availableCredits: number;
}

interface MovementInput {
  walletId: string;
  organizationId: string;
  type: WalletTransactionType;
  direction: WalletTransactionDirection;
  amountCredits: number;
  referenceType?: string | null;
  referenceId?: string | null;
  idempotencyKey: string;
  descriptionCode?: string | null;
}

interface MovementResult {
  walletTransactionId: string;
  balanceAfterCredits: number;
  reservedAfterCredits: number;
  availableAfterCredits: number;
  replayed: boolean;
}

@Injectable()
export class WalletReservationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Provisioning idempotent HORS transaction (un P2002 EN transaction avorterait
   * tout — 25P02) : garantit qu'un Wallet existe pour l'Organization et renvoie
   * son id. Concurrence protégée par l'index unique `organizationId`.
   */
  async ensureWalletId(organizationId: string): Promise<string> {
    const existing = await this.prisma.wallet.findUnique({
      where: { organizationId },
      select: { id: true },
    });
    if (existing) {
      return existing.id;
    }
    try {
      const created = await this.prisma.wallet.create({
        data: { organizationId },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
      const wallet = await this.prisma.wallet.findUniqueOrThrow({
        where: { organizationId },
        select: { id: true },
      });
      return wallet.id;
    }
  }

  /** Verrou `FOR UPDATE` du Wallet (sérialise les mouvements cross-conversation) + lecture. */
  async lockAndReadWallet(
    tx: PrismaTransaction,
    walletId: string,
    organizationId: string,
  ): Promise<LockedWallet> {
    await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${walletId} AND "organizationId" = ${organizationId} FOR UPDATE`;
    const wallet = await tx.wallet.findUnique({
      where: { id: walletId },
      select: { balanceCredits: true, reservedCredits: true, status: true },
    });
    if (!wallet) {
      throw new WalletNotFoundError();
    }
    return {
      balanceCredits: wallet.balanceCredits,
      reservedCredits: wallet.reservedCredits,
      status: wallet.status,
      availableCredits: availableCredits(wallet),
    };
  }

  /**
   * Réserve `MAX_CREDITS_PER_AI_RUN` pour un run (RESERVE : `reserved += 3`,
   * `balance` inchangé) ET crée l'AiUsageEvent RESERVED lié 1:1, dans la
   * transaction fournie. À appeler APRÈS `lockAndReadWallet` (le disponible a
   * déjà été vérifié). Idempotent : la clé de réservation déjà écrite → no-op.
   */
  async reserveForRunInTx(
    tx: PrismaTransaction,
    params: {
      organizationId: string;
      shopId: string;
      walletId: string;
      aiRunId: string;
      provider: string;
      requestedModel: string | null;
      resolvedModel?: string | null;
    },
  ): Promise<MovementResult> {
    const movement = await this.applyMovementInTx(tx, {
      walletId: params.walletId,
      organizationId: params.organizationId,
      type: 'AI_USAGE_RESERVATION',
      direction: 'RESERVE',
      amountCredits: MAX_CREDITS_PER_AI_RUN,
      referenceType: 'AI_RUN',
      referenceId: params.aiRunId,
      idempotencyKey: aiUsageReservationKey(params.aiRunId),
      descriptionCode: 'AI_RUN_RESERVED',
    });

    await tx.aiUsageEvent.upsert({
      where: { aiRunId: params.aiRunId },
      update: {},
      create: {
        organizationId: params.organizationId,
        shopId: params.shopId,
        walletId: params.walletId,
        aiRunId: params.aiRunId,
        provider: params.provider as never,
        requestedModel: params.requestedModel,
        resolvedModel: params.resolvedModel ?? null,
        creditsReserved: MAX_CREDITS_PER_AI_RUN,
        creditsCharged: 0,
        successfulToolCalls: 0,
        pricingVersion: 'v1',
        reasonCode: 'AI_RUN_RESERVED',
        status: 'RESERVED',
        idempotencyKey: usageEventKey(params.aiRunId),
        walletTransactionId: movement.walletTransactionId,
      },
      select: { id: true },
    });

    return movement;
  }

  /**
   * Trace un run NON facturé (crédits insuffisants, Wallet suspendu/fermé,
   * garde) : AiUsageEvent SKIPPED à 0 crédit, pour conserver le 1:1 avec l'AiRun.
   * Aucun mouvement Wallet. Idempotent (upsert par aiRunId).
   */
  async recordSkippedForRunInTx(
    tx: PrismaTransaction,
    params: {
      organizationId: string;
      shopId: string;
      walletId: string;
      aiRunId: string;
      provider: string;
      requestedModel: string | null;
      reasonCode: string;
    },
  ): Promise<void> {
    await tx.aiUsageEvent.upsert({
      where: { aiRunId: params.aiRunId },
      update: {},
      create: {
        organizationId: params.organizationId,
        shopId: params.shopId,
        walletId: params.walletId,
        aiRunId: params.aiRunId,
        provider: params.provider as never,
        requestedModel: params.requestedModel,
        creditsReserved: 0,
        creditsCharged: 0,
        successfulToolCalls: 0,
        pricingVersion: 'v1',
        reasonCode: params.reasonCode,
        status: 'SKIPPED',
        idempotencyKey: usageEventKey(params.aiRunId),
        completedAt: new Date(),
      },
      select: { id: true },
    });
  }

  /**
   * Libère STRICTEMENT une fois le reliquat de réservation d'un run (supersede).
   * Lit l'AiUsageEvent RESERVED du run ; s'il n'existe pas / n'est pas RESERVED
   * / reliquat nul → no-op. La transition conditionnelle RESERVED→RELEASED GATE
   * le mouvement RELEASE (jamais de double libération). Ne touche pas un Wallet
   * CLOSED (aucun mouvement possible — le sweep du groupe 5 réconciliera).
   */
  async releaseRunReservationInTx(
    tx: PrismaTransaction,
    params: { organizationId: string; aiRunId: string },
  ): Promise<{ released: boolean; walletId: string | null }> {
    const usage = await tx.aiUsageEvent.findUnique({
      where: { aiRunId: params.aiRunId },
      select: { id: true, walletId: true, status: true, creditsReserved: true, creditsCharged: true },
    });
    if (!usage || usage.status !== 'RESERVED') {
      return { released: false, walletId: usage?.walletId ?? null };
    }
    const outstanding = usage.creditsReserved - usage.creditsCharged;
    if (outstanding <= 0) {
      await tx.aiUsageEvent.updateMany({
        where: { id: usage.id, status: 'RESERVED' },
        data: { status: 'RELEASED', completedAt: new Date() },
      });
      return { released: false, walletId: usage.walletId };
    }

    // GATE : seule la première transition RESERVED→RELEASED déclenche le RELEASE.
    const gate = await tx.aiUsageEvent.updateMany({
      where: { id: usage.id, status: 'RESERVED' },
      data: { status: 'RELEASED', completedAt: new Date() },
    });
    if (gate.count !== 1) {
      return { released: false, walletId: usage.walletId };
    }

    const wallet = await this.lockAndReadWallet(tx, usage.walletId, params.organizationId);
    if (wallet.status === 'CLOSED') {
      // Un Wallet fermé ne peut recevoir aucun mouvement ; le sweep G5 gèrera.
      return { released: false, walletId: usage.walletId };
    }

    const movement = await this.applyMovementInTx(tx, {
      walletId: usage.walletId,
      organizationId: params.organizationId,
      type: 'AI_USAGE_RELEASE',
      direction: 'RELEASE',
      amountCredits: outstanding,
      referenceType: 'AI_RUN',
      referenceId: params.aiRunId,
      idempotencyKey: aiUsageReleaseKey(params.aiRunId),
      descriptionCode: 'AI_RUN_SUPERSEDED_RELEASE',
    });
    await tx.aiUsageEvent.update({
      where: { id: usage.id },
      data: { walletTransactionId: movement.walletTransactionId },
      select: { id: true },
    });
    return { released: !movement.replayed, walletId: usage.walletId };
  }

  /**
   * FINALISE la réservation d'un run terminé (groupe 5), DANS la transaction qui
   * pose le statut terminal du run. Débite le COÛT RÉEL (`computeAiRunCredits` —
   * grille v1, basée sur les outils RÉUSSIS) et LIBÈRE la totalité de la
   * réservation, sans double comptage : `balance -= coût`, `reserved -= réservé`.
   *
   * - GATE conditionnel `RESERVED → CHARGED|RELEASED` : rejeu / run déjà finalisé
   *   → no-op strict (jamais de double débit).
   * - Wallet non ACTIVE : on NE FACTURE PAS (favorable au marchand, jamais de
   *   solde négatif) ; on libère la réservation si le Wallet le permet (CLOSED
   *   bloque tout mouvement → réservation gelée avec le Wallet fermé).
   * - Issues non facturables (HANDOFF/NO_REPLY/FAILED/SUPERSEDED) → coût 0,
   *   simple libération.
   */
  async finalizeRunReservationInTx(
    tx: PrismaTransaction,
    params: { organizationId: string; aiRunId: string; outcome: AiRunBillableOutcome },
  ): Promise<{ changed: boolean; walletId: string | null; creditsCharged: number }> {
    const usage = await tx.aiUsageEvent.findUnique({
      where: { aiRunId: params.aiRunId },
      select: { id: true, walletId: true, status: true, creditsReserved: true, creditsCharged: true },
    });
    if (!usage || usage.status !== 'RESERVED') {
      return { changed: false, walletId: usage?.walletId ?? null, creditsCharged: 0 };
    }

    // Base de tarification = outils RÉUSSIS (D5), source = AiToolCall SUCCEEDED.
    const successfulToolCalls = await tx.aiToolCall.count({
      where: { aiRunId: params.aiRunId, status: 'SUCCEEDED' },
    });
    const pricing = computeAiRunCredits({ outcome: params.outcome, successfulToolCalls });
    const outstanding = usage.creditsReserved - usage.creditsCharged;
    const charge = Math.min(pricing.creditsRequired, Math.max(0, outstanding));

    const wallet = await this.lockAndReadWallet(tx, usage.walletId, params.organizationId);
    const canCharge = wallet.status === 'ACTIVE';
    const effectiveCharge = canCharge ? charge : 0;

    // GATE : première finalisation seulement (RESERVED → CHARGED|RELEASED).
    const target = effectiveCharge > 0 ? 'CHARGED' : 'RELEASED';
    const gate = await tx.aiUsageEvent.updateMany({
      where: { id: usage.id, status: 'RESERVED' },
      data: {
        status: target,
        creditsCharged: effectiveCharge,
        successfulToolCalls,
        pricingVersion: pricing.pricingVersion,
        reasonCode: canCharge ? pricing.reasonCode : 'NOT_BILLABLE_WALLET_INACTIVE',
        action: params.outcome,
        completedAt: new Date(),
      },
    });
    if (gate.count !== 1) {
      return { changed: false, walletId: usage.walletId, creditsCharged: 0 };
    }

    if (wallet.status === 'CLOSED') {
      // Aucun mouvement possible ; la réservation reste gelée avec le Wallet fermé.
      return { changed: true, walletId: usage.walletId, creditsCharged: 0 };
    }

    let debitTxId: string | null = null;
    if (effectiveCharge > 0) {
      const debit = await this.applyMovementInTx(tx, {
        walletId: usage.walletId,
        organizationId: params.organizationId,
        type: 'AI_USAGE_DEBIT',
        direction: 'DEBIT',
        amountCredits: effectiveCharge,
        referenceType: 'AI_RUN',
        referenceId: params.aiRunId,
        idempotencyKey: aiUsageDebitKey(params.aiRunId),
        descriptionCode: 'AI_RUN_CHARGED',
      });
      debitTxId = debit.walletTransactionId;
    }
    if (outstanding > 0) {
      await this.applyMovementInTx(tx, {
        walletId: usage.walletId,
        organizationId: params.organizationId,
        type: 'AI_USAGE_RELEASE',
        direction: 'RELEASE',
        amountCredits: outstanding,
        referenceType: 'AI_RUN',
        referenceId: params.aiRunId,
        idempotencyKey: aiUsageReleaseKey(params.aiRunId),
        descriptionCode: 'AI_RUN_RESERVATION_SETTLED',
      });
    }
    if (debitTxId) {
      await tx.aiUsageEvent.update({
        where: { id: usage.id },
        data: { walletTransactionId: debitTxId },
        select: { id: true },
      });
    }
    return { changed: true, walletId: usage.walletId, creditsCharged: effectiveCharge };
  }

  /**
   * Construit le payload temps réel `wallet.balance.updated` (soldes agrégés +
   * `aiAvailable` dérivé). Aucun secret. Renvoie `null` si le Wallet est
   * introuvable. Source UNIQUE de la forme du payload (trigger/orchestrateur/sweep).
   */
  async buildBalanceEvent(
    organizationId: string,
    walletId: string,
    extra: Partial<Pick<WalletRealtimeEvent, 'conversationId' | 'requiredCredits'>> = {},
  ): Promise<WalletRealtimeEvent | null> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId },
      select: { balanceCredits: true, reservedCredits: true, status: true, version: true },
    });
    if (!wallet) {
      return null;
    }
    const available = wallet.balanceCredits - wallet.reservedCredits;
    return {
      organizationId,
      walletId,
      balanceCredits: wallet.balanceCredits,
      reservedCredits: wallet.reservedCredits,
      availableCredits: available,
      aiAvailable: wallet.status === 'ACTIVE' && available >= MAX_CREDITS_PER_AI_RUN,
      version: wallet.version,
      ...extra,
    };
  }

  /**
   * Applique UN mouvement de crédits DANS la transaction fournie — miroir de
   * `WalletService.applyMovementInTx` (API), sur les MÊMES primitives pures.
   * `FOR UPDATE` → idempotence (clé) → statut (CLOSED bloque tout ; RESERVE/DEBIT
   * exigent ACTIVE ; RELEASE/CREDIT tolérés SUSPENDED) → invariants purs →
   * WalletTransaction (before/after) → maj Wallet (+version).
   */
  private async applyMovementInTx(
    tx: PrismaTransaction,
    movement: MovementInput,
  ): Promise<MovementResult> {
    await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${movement.walletId} AND "organizationId" = ${movement.organizationId} FOR UPDATE`;

    const existing = await tx.walletTransaction.findUnique({
      where: { idempotencyKey: movement.idempotencyKey },
      select: { id: true, balanceAfterCredits: true, reservedAfterCredits: true },
    });
    if (existing) {
      return {
        walletTransactionId: existing.id,
        balanceAfterCredits: existing.balanceAfterCredits,
        reservedAfterCredits: existing.reservedAfterCredits,
        availableAfterCredits: existing.balanceAfterCredits - existing.reservedAfterCredits,
        replayed: true,
      };
    }

    const wallet = await tx.wallet.findUnique({
      where: { id: movement.walletId },
      select: { balanceCredits: true, reservedCredits: true, status: true },
    });
    if (!wallet) {
      throw new WalletNotFoundError();
    }
    if (wallet.status === 'CLOSED') {
      throw new WalletClosedError();
    }
    const spends = movement.direction === 'RESERVE' || movement.direction === 'DEBIT';
    if (spends && wallet.status !== 'ACTIVE') {
      throw new WalletSuspendedError();
    }
    if (!isTypeDirectionValid(movement.type, movement.direction)) {
      throw new WalletInvariantViolationError('TYPE_DIRECTION_MISMATCH');
    }

    const before = { balanceCredits: wallet.balanceCredits, reservedCredits: wallet.reservedCredits };
    const after = computeBalancesAfter(before, {
      direction: movement.direction,
      amountCredits: movement.amountCredits,
    });

    const walletTx = await tx.walletTransaction.create({
      data: {
        organizationId: movement.organizationId,
        walletId: movement.walletId,
        type: movement.type,
        direction: movement.direction,
        amountCredits: movement.amountCredits,
        balanceBeforeCredits: before.balanceCredits,
        balanceAfterCredits: after.balanceCredits,
        reservedBeforeCredits: before.reservedCredits,
        reservedAfterCredits: after.reservedCredits,
        referenceType: movement.referenceType ?? null,
        referenceId: movement.referenceId ?? null,
        idempotencyKey: movement.idempotencyKey,
        descriptionCode: movement.descriptionCode ?? null,
      },
      select: { id: true },
    });

    await tx.wallet.update({
      where: { id: movement.walletId },
      data: {
        balanceCredits: after.balanceCredits,
        reservedCredits: after.reservedCredits,
        version: { increment: 1 },
      },
      select: { id: true },
    });

    return {
      walletTransactionId: walletTx.id,
      balanceAfterCredits: after.balanceCredits,
      reservedAfterCredits: after.reservedCredits,
      availableAfterCredits: after.balanceCredits - after.reservedCredits,
      replayed: false,
    };
  }
}

/** Clé d'idempotence de l'AiUsageEvent (distincte des clés de mouvement Wallet). */
function usageEventKey(aiRunId: string): string {
  return `ai-usage-event:${aiRunId}`;
}
