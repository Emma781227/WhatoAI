import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import { OrderStockConsumptionError, OrderStockRestorationError } from '@whauto/shared';

interface ConsumeCounters {
  beforeOnHand: number;
  beforeReserved: number;
  afterOnHand: number;
  afterReserved: number;
}

/**
 * Primitives ATOMIQUES de consommation/restitution du stock d'une commande —
 * même famille que ReservationService : UPDATE conditionnel avec capture des
 * compteurs avant/après dans le même statement, jamais de read-then-write.
 */
@Injectable()
export class OrderStockService {
  /**
   * Consommation backorder-aware (validé — ajustement 11) :
   * - reserved décrémenté de TOUTE la quantité réservée (la réservation est
   *   consommée) ;
   * - onHand décrémenté de LEAST(quantité, onHand) uniquement — JAMAIS
   *   négatif ; le surplus est le backorder (rien ne sort physiquement) ;
   * - condition `reserved >= quantité` : 0 ligne = état incohérent → échec.
   * Le sous-select FOR UPDATE capture les compteurs AVANT dans le même
   * statement (before/after exacts par construction).
   */
  async consume(
    tx: Prisma.TransactionClient,
    input: { variantId: string; quantity: number },
  ): Promise<{ consumedFromStock: number; backordered: number; counters: ConsumeCounters }> {
    const rows = await tx.$queryRaw<
      Array<{
        beforeOnHand: number;
        beforeReserved: number;
        quantityOnHand: number;
        quantityReserved: number;
      }>
    >`
      UPDATE "inventory_items" i
      SET "quantityOnHand" = i."quantityOnHand" - LEAST(${input.quantity}, i."quantityOnHand"),
          "quantityReserved" = i."quantityReserved" - ${input.quantity},
          "version" = i."version" + 1,
          "updatedAt" = NOW()
      FROM (
        SELECT "variantId" AS vid, "quantityOnHand" AS "beforeOnHand", "quantityReserved" AS "beforeReserved"
        FROM "inventory_items"
        WHERE "variantId" = ${input.variantId}
        FOR UPDATE
      ) o
      WHERE i."variantId" = o.vid AND i."quantityReserved" >= ${input.quantity}
      RETURNING o."beforeOnHand", o."beforeReserved", i."quantityOnHand", i."quantityReserved"
    `;
    const row = rows[0];
    if (!row) {
      throw new OrderStockConsumptionError();
    }
    const counters: ConsumeCounters = {
      beforeOnHand: row.beforeOnHand,
      beforeReserved: row.beforeReserved,
      afterOnHand: row.quantityOnHand,
      afterReserved: row.quantityReserved,
    };
    const consumedFromStock = counters.beforeOnHand - counters.afterOnHand;
    return {
      consumedFromStock,
      backordered: input.quantity - consumedFromStock,
      counters,
    };
  }

  /**
   * Restitution d'annulation : onHand réaugmenté de la quantité RÉELLEMENT
   * consommée (stockConsumedQuantity historique — jamais trackInventory
   * courant). InventoryItem absent = 0 ligne → OrderStockRestorationError,
   * l'annulation entière est rollback (validé — ajustement 9, jamais de
   * restitution silencieuse à zéro).
   */
  async restore(
    tx: Prisma.TransactionClient,
    input: { variantId: string; quantity: number },
  ): Promise<ConsumeCounters> {
    const rows = await tx.$queryRaw<
      Array<{
        beforeOnHand: number;
        beforeReserved: number;
        quantityOnHand: number;
        quantityReserved: number;
      }>
    >`
      UPDATE "inventory_items" i
      SET "quantityOnHand" = i."quantityOnHand" + ${input.quantity},
          "version" = i."version" + 1,
          "updatedAt" = NOW()
      FROM (
        SELECT "variantId" AS vid, "quantityOnHand" AS "beforeOnHand", "quantityReserved" AS "beforeReserved"
        FROM "inventory_items"
        WHERE "variantId" = ${input.variantId}
        FOR UPDATE
      ) o
      WHERE i."variantId" = o.vid
      RETURNING o."beforeOnHand", o."beforeReserved", i."quantityOnHand", i."quantityReserved"
    `;
    const row = rows[0];
    if (!row) {
      throw new OrderStockRestorationError();
    }
    return {
      beforeOnHand: row.beforeOnHand,
      beforeReserved: row.beforeReserved,
      afterOnHand: row.quantityOnHand,
      afterReserved: row.quantityReserved,
    };
  }

  /** Mouvement SALE — delta = quantité réellement SORTIE du stock (peut être 0 si tout est backorder). */
  async recordSale(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      shopId: string;
      variantId: string;
      orderId: string;
      counters: ConsumeCounters;
      consumedFromStock: number;
      actorUserId: string | null;
    },
  ): Promise<void> {
    await tx.inventoryMovement.create({
      data: {
        organizationId: input.organizationId,
        shopId: input.shopId,
        variantId: input.variantId,
        type: 'SALE',
        quantityDelta: -input.consumedFromStock,
        quantityBefore: input.counters.beforeOnHand,
        quantityAfter: input.counters.afterOnHand,
        quantityReservedBefore: input.counters.beforeReserved,
        quantityReservedAfter: input.counters.afterReserved,
        referenceType: 'ORDER',
        referenceId: input.orderId,
        actorUserId: input.actorUserId,
      },
      select: { id: true },
    });
  }

  /** Mouvement CANCELLATION — delta POSITIF = stock restitué. reserved inchangé. */
  async recordCancellation(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      shopId: string;
      variantId: string;
      orderId: string;
      counters: ConsumeCounters;
      restored: number;
      actorUserId: string | null;
    },
  ): Promise<void> {
    await tx.inventoryMovement.create({
      data: {
        organizationId: input.organizationId,
        shopId: input.shopId,
        variantId: input.variantId,
        type: 'CANCELLATION',
        quantityDelta: input.restored,
        quantityBefore: input.counters.beforeOnHand,
        quantityAfter: input.counters.afterOnHand,
        referenceType: 'ORDER',
        referenceId: input.orderId,
        actorUserId: input.actorUserId,
      },
      select: { id: true },
    });
  }
}
