import { Injectable } from '@nestjs/common';
import type { Prisma, StockReservationStatus } from '@whauto/database';
import {
  CartInsufficientStockError,
  ReservationConcurrencyError,
} from '@whauto/shared';

export interface ReservationConfig {
  ttlMinutes: number;
  maxLifetimeMinutes: number;
  renewalMinIntervalSeconds: number;
}

interface InventoryCounters {
  quantityOnHand: number;
  quantityReserved: number;
}

/**
 * Primitives de réservation de stock — TOUJOURS appelées dans une transaction
 * appelante (jamais de transaction propre) : la création StockReservation,
 * l'incrément quantityReserved, le mouvement RESERVATION et la transition du
 * Cart restent atomiques ensemble.
 *
 * Sémantique des mouvements (décision validée) : RESERVATION/RELEASE ne
 * touchent QUE quantityReserved — quantityBefore/After décrivent onHand
 * inchangé (delta = 0), le changement réel est dans quantityReservedBefore/
 * After (CHECK SQL en garde-fou).
 *
 * Réservations pilotées EXCLUSIVEMENT par les services Cart/Checkout et le
 * sweep du worker — aucune route publique.
 */
@Injectable()
export class ReservationService {
  /**
   * Incrément ATOMIQUE conditionnel de quantityReserved (jamais de
   * read-then-write) : la condition joint product_variants car allowBackorder
   * vit sur la variante. 0 ligne = stock insuffisant, RIEN n'est écrit.
   * Le stock physique (onHand) n'est jamais touché ni négatif.
   */
  private async atomicReserve(
    tx: Prisma.TransactionClient,
    variantId: string,
    quantity: number,
  ): Promise<InventoryCounters | null> {
    const rows = await tx.$queryRaw<InventoryCounters[]>`
      UPDATE "inventory_items" i
      SET "quantityReserved" = i."quantityReserved" + ${quantity},
          "version" = i."version" + 1,
          "updatedAt" = NOW()
      FROM "product_variants" v
      WHERE v."id" = i."variantId"
        AND i."variantId" = ${variantId}
        AND (v."allowBackorder" OR i."quantityOnHand" - i."quantityReserved" >= ${quantity})
      RETURNING i."quantityOnHand", i."quantityReserved"
    `;
    return rows[0] ?? null;
  }

  /** Décrément atomique (release) — le CHECK reserved >= 0 est le garde-fou final. */
  private async atomicRelease(
    tx: Prisma.TransactionClient,
    variantId: string,
    quantity: number,
  ): Promise<InventoryCounters> {
    const rows = await tx.$queryRaw<InventoryCounters[]>`
      UPDATE "inventory_items"
      SET "quantityReserved" = "quantityReserved" - ${quantity},
          "version" = "version" + 1,
          "updatedAt" = NOW()
      WHERE "variantId" = ${variantId}
      RETURNING "quantityOnHand", "quantityReserved"
    `;
    if (rows.length === 0) {
      throw new ReservationConcurrencyError();
    }
    return rows[0];
  }

  private async recordMovement(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      shopId: string;
      variantId: string;
      type: 'RESERVATION' | 'RELEASE';
      counters: InventoryCounters;
      reservedDelta: number;
      reservationId: string;
      actorUserId?: string | null;
      reason?: string;
    },
  ): Promise<void> {
    await tx.inventoryMovement.create({
      data: {
        organizationId: input.organizationId,
        shopId: input.shopId,
        variantId: input.variantId,
        type: input.type,
        // onHand INCHANGÉ : delta 0, before = after (sens des colonnes préservé).
        quantityDelta: 0,
        quantityBefore: input.counters.quantityOnHand,
        quantityAfter: input.counters.quantityOnHand,
        quantityReservedBefore: input.counters.quantityReserved - input.reservedDelta,
        quantityReservedAfter: input.counters.quantityReserved,
        referenceType: 'STOCK_RESERVATION',
        referenceId: input.reservationId,
        reason: input.reason ?? null,
        actorUserId: input.actorUserId ?? null,
      },
      select: { id: true },
    });
  }

  /**
   * Nouveau CYCLE de réservation pour une ligne (une nouvelle ligne
   * StockReservation — jamais de réutilisation d'une historique, validé).
   * Variante non suivie → null (rien à réserver).
   */
  async reserveForItem(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      shopId: string;
      cartId: string;
      cartItemId: string;
      variantId: string;
      quantity: number;
      trackInventory: boolean;
      config: ReservationConfig;
      actorUserId?: string | null;
    },
  ): Promise<{ id: string; expiresAt: Date } | null> {
    if (!input.trackInventory) {
      return null;
    }
    const counters = await this.atomicReserve(tx, input.variantId, input.quantity);
    if (counters === null) {
      throw new CartInsufficientStockError();
    }

    const now = Date.now();
    const expiresAt = new Date(now + input.config.ttlMinutes * 60_000);
    const maxExpiresAt = new Date(now + input.config.maxLifetimeMinutes * 60_000);
    const reservation = await tx.stockReservation.create({
      data: {
        organizationId: input.organizationId,
        shopId: input.shopId,
        cartId: input.cartId,
        cartItemId: input.cartItemId,
        variantId: input.variantId,
        quantity: input.quantity,
        expiresAt,
        maxExpiresAt,
      },
      select: { id: true, expiresAt: true },
    });

    await this.recordMovement(tx, {
      organizationId: input.organizationId,
      shopId: input.shopId,
      variantId: input.variantId,
      type: 'RESERVATION',
      counters,
      reservedDelta: input.quantity,
      reservationId: reservation.id,
      actorUserId: input.actorUserId,
    });
    return reservation;
  }

  /**
   * Ajuste la quantité d'une réservation ACTIVE (delta signé, validé §18) :
   * augmentation = réserver UNIQUEMENT la différence (échec → l'appelant
   * rollback tout) ; réduction = release de la différence, même transaction.
   */
  async adjustActiveReservation(
    tx: Prisma.TransactionClient,
    reservation: { id: string; variantId: string; organizationId: string; shopId: string },
    delta: number,
    actorUserId?: string | null,
  ): Promise<void> {
    if (delta === 0) {
      return;
    }
    let counters: InventoryCounters;
    if (delta > 0) {
      const reserved = await this.atomicReserve(tx, reservation.variantId, delta);
      if (reserved === null) {
        throw new CartInsufficientStockError();
      }
      counters = reserved;
    } else {
      counters = await this.atomicRelease(tx, reservation.variantId, -delta);
    }

    const updated = await tx.stockReservation.updateMany({
      where: { id: reservation.id, status: 'ACTIVE' },
      data: { quantity: { increment: delta } },
    });
    if (updated.count !== 1) {
      // Expirée/libérée concurremment : la transaction appelante annule tout.
      throw new ReservationConcurrencyError();
    }

    await this.recordMovement(tx, {
      organizationId: reservation.organizationId,
      shopId: reservation.shopId,
      variantId: reservation.variantId,
      type: delta > 0 ? 'RESERVATION' : 'RELEASE',
      counters,
      reservedDelta: delta,
      reservationId: reservation.id,
      actorUserId,
    });
  }

  /**
   * Release IDEMPOTENTE : la transition conditionnelle ACTIVE → terminal
   * garantit qu'une double libération est un no-op (count = 0, rien d'écrit).
   */
  async releaseReservation(
    tx: Prisma.TransactionClient,
    reservation: {
      id: string;
      variantId: string;
      quantity: number;
      organizationId: string;
      shopId: string;
    },
    targetStatus: Extract<StockReservationStatus, 'RELEASED' | 'EXPIRED' | 'CANCELLED'>,
    reason?: string,
  ): Promise<boolean> {
    const transitioned = await tx.stockReservation.updateMany({
      where: { id: reservation.id, status: 'ACTIVE' },
      data: { status: targetStatus, releasedAt: new Date() },
    });
    if (transitioned.count !== 1) {
      return false; // déjà libérée — idempotent
    }
    const counters = await this.atomicRelease(tx, reservation.variantId, reservation.quantity);
    await this.recordMovement(tx, {
      organizationId: reservation.organizationId,
      shopId: reservation.shopId,
      variantId: reservation.variantId,
      type: 'RELEASE',
      counters,
      reservedDelta: -reservation.quantity,
      reservationId: reservation.id,
      reason,
    });
    return true;
  }

  /**
   * Renouvellement CONTRÔLÉ (validé §16) : jamais sur simple affichage —
   * appelé uniquement sur action significative ; throttle minIntervalSeconds ;
   * jamais au-delà de maxExpiresAt (durée cumulée plafonnée).
   */
  async renewIfDue(
    tx: Prisma.TransactionClient,
    reservation: {
      id: string;
      expiresAt: Date;
      maxExpiresAt: Date;
      lastRenewedAt: Date | null;
      createdAt: Date;
    },
    config: ReservationConfig,
  ): Promise<Date | null> {
    const now = Date.now();
    const lastAction = (reservation.lastRenewedAt ?? reservation.createdAt).getTime();
    if (now - lastAction < config.renewalMinIntervalSeconds * 1000) {
      return null; // trop tôt — no-op silencieux
    }
    const candidate = Math.min(
      now + config.ttlMinutes * 60_000,
      reservation.maxExpiresAt.getTime(),
    );
    if (candidate <= reservation.expiresAt.getTime()) {
      return null; // plafond atteint
    }
    const newExpiry = new Date(candidate);
    const updated = await tx.stockReservation.updateMany({
      where: { id: reservation.id, status: 'ACTIVE' },
      data: { expiresAt: newExpiry, lastRenewedAt: new Date(now), renewedCount: { increment: 1 } },
    });
    return updated.count === 1 ? newExpiry : null;
  }
}
