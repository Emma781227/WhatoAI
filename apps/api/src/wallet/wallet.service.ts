import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import {
  availableCredits,
  computeBalancesAfter,
  isTypeDirectionValid,
  WalletClosedError,
  WalletInvariantViolationError,
  WalletNotFoundError,
  WalletSuspendedError,
  type WalletStatus,
  type WalletTransactionDirection,
  type WalletTransactionType,
} from '@whauto/wallet';

import { PrismaService } from '../prisma/prisma.service';

/** Transaction Prisma fournie (provisioning atomique avec la création d'Organization). */
export type PrismaTransaction = Prisma.TransactionClient;

/** Un mouvement de crédits à appliquer sur le Wallet (une ligne de ledger). */
export interface WalletMovementInput {
  walletId: string;
  organizationId: string;
  type: WalletTransactionType;
  direction: WalletTransactionDirection;
  amountCredits: number;
  referenceType?: string | null;
  referenceId?: string | null;
  idempotencyKey: string;
  descriptionCode?: string | null;
  metadataFiltered?: Prisma.InputJsonValue;
  createdByUserId?: string | null;
}

/** Résultat d'un mouvement (soldes APRÈS, pour l'appelant/le realtime). */
export interface WalletMovementResult {
  walletTransactionId: string;
  balanceAfterCredits: number;
  reservedAfterCredits: number;
  availableAfterCredits: number;
  /** true si le mouvement existait déjà (rejeu idempotent) — aucun double effet. */
  replayed: boolean;
}

/** Instantané public d'un Wallet (le disponible est TOUJOURS dérivé, jamais stocké). */
export interface WalletSnapshot {
  id: string;
  balanceCredits: number;
  reservedCredits: number;
  availableCredits: number;
  status: WalletStatus;
  version: number;
}

const WALLET_SELECT = {
  id: true,
  balanceCredits: true,
  reservedCredits: true,
  status: true,
  version: true,
} satisfies Prisma.WalletSelect;

function toSnapshot(row: {
  id: string;
  balanceCredits: number;
  reservedCredits: number;
  status: WalletStatus;
  version: number;
}): WalletSnapshot {
  return {
    id: row.id,
    balanceCredits: row.balanceCredits,
    reservedCredits: row.reservedCredits,
    availableCredits: availableCredits(row),
    status: row.status,
    version: row.version,
  };
}

/**
 * Provisioning et lecture du Wallet (groupe 1). Un Wallet par Organization,
 * mutualisé entre toutes ses Shops. Ce groupe ne fait AUCUN mouvement de crédits
 * (crédit/débit/réservation viennent aux groupes suivants) : uniquement la
 * création (à 0 crédit, ACTIVE) et la lecture idempotente.
 *
 * L'audit `WALLET_CREATED` est écrit par l'appelant (OrganizationsService) dans
 * la même transaction — évite un couplage circulaire Wallet ↔ Organizations.
 */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Crée le Wallet dans la transaction FOURNIE (création d'Organization). Create
   * SIMPLE — jamais de rattrapage P2002 EN transaction (un P2002 avorterait la
   * transaction Prisma : erreur 25P02). L'org est neuve à cet appel, donc aucun
   * conflit ; l'idempotence de compatibilité vit dans `ensureWallet` (hors tx).
   */
  async createInTx(tx: PrismaTransaction, organizationId: string): Promise<{ id: string }> {
    return tx.wallet.create({ data: { organizationId }, select: { id: true } });
  }

  /**
   * Get-or-create idempotent (filet de compatibilité pour une Organization sans
   * Wallet). Le backfill a déjà provisionné les Organizations existantes ; les
   * nouvelles reçoivent leur Wallet à la création. Ne fait aucun mouvement.
   * Le conflit de course (P2002) est rattrapé HORS transaction, puis relu.
   */
  async ensureWallet(organizationId: string): Promise<WalletSnapshot> {
    const existing = await this.prisma.wallet.findUnique({
      where: { organizationId },
      select: WALLET_SELECT,
    });
    if (existing) {
      return toSnapshot(existing);
    }
    try {
      await this.prisma.wallet.create({ data: { organizationId }, select: { id: true } });
    } catch (error) {
      // Course : une autre requête l'a créé entre-temps (index unique). On relit.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
    }
    const wallet = await this.prisma.wallet.findUniqueOrThrow({
      where: { organizationId },
      select: WALLET_SELECT,
    });
    return toSnapshot(wallet);
  }

  /**
   * Applique UN mouvement de crédits sur le Wallet, DANS la transaction fournie.
   * Séquence : `FOR UPDATE` du Wallet (sérialise les mouvements) → idempotence
   * (`idempotencyKey` déjà écrit ⇒ no-op, on renvoie l'existant) → validation
   * type/direction → invariants purs (`computeBalancesAfter`) → WalletTransaction
   * (before/after) → maj Wallet (+version). Le CREDIT reste possible sur un
   * Wallet SUSPENDED (recharge) ; RESERVE/DEBIT exigent ACTIVE ; CLOSED bloque tout.
   */
  async applyMovementInTx(
    tx: PrismaTransaction,
    movement: WalletMovementInput,
  ): Promise<WalletMovementResult> {
    // Sérialise les mouvements concurrents sur CE wallet.
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
        ...(movement.metadataFiltered !== undefined
          ? { metadataFiltered: movement.metadataFiltered }
          : {}),
        createdByUserId: movement.createdByUserId ?? null,
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

  /** Applique un mouvement dans sa propre transaction (mouvement isolé). */
  async creditWallet(movement: WalletMovementInput): Promise<WalletMovementResult> {
    return this.prisma.$transaction((tx) => this.applyMovementInTx(tx, movement));
  }
}
