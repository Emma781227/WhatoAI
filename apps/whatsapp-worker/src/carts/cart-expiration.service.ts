import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@whauto/database';
import { SOCKET_EVENTS } from '@whauto/shared';
import type { CartRealtimeEvent } from '@whauto/shared';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEmitterService } from '../whatsapp/realtime-emitter.service';

const SWEEP_BATCH_SIZE = 100;

/**
 * Sweep d'expiration du panier conversationnel (pattern inbox/outbox validé) :
 *
 * 1. RÉSERVATIONS expirées : ACTIVE avec expiresAt < now → EXPIRED +
 *    décrément atomique de quantityReserved + mouvement RELEASE (mêmes
 *    primitives sémantiques que l'API : delta onHand = 0, colonnes réservées
 *    renseignées). Si le panier n'a plus AUCUNE réservation ACTIVE :
 *    CHECKOUT_STARTED → ACTIVE (CheckoutSession et données client CONSERVÉES —
 *    validé D8 ; un checkout CONFIRMED n'est jamais rétrogradé : son snapshot
 *    devient simplement non convertible sans nouveau cycle).
 * 2. PANIERS inactifs : ouverts avec expiresAt < now → EXPIRED (+ release des
 *    réservations restantes, session non confirmée → EXPIRED, audit
 *    CART_EXPIRED). Les paniers au checkout CONFIRMED sont EXCLUS (ils
 *    attendent la conversion en Order).
 * 3. Filet anti-orphelins : réservation ACTIVE d'un panier terminal → release
 *    (invariant "aucun stock réservé orphelin" — normalement mort).
 * 4. Purge des CartMutation > 24 h (idempotence).
 *
 * Toutes les étapes sont IDEMPOTENTES (transitions conditionnelles) — un
 * sweep concurrent ou rejoué ne double jamais un release.
 */
@Injectable()
export class CartExpirationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CartExpirationService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  onModuleInit(): void {
    const intervalSeconds =
      this.configService.get<number>('CART_EXPIRATION_SWEEP_INTERVAL_SECONDS') ?? 30;
    this.timer = setInterval(() => {
      void this.sweep();
    }, intervalSeconds * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async sweep(): Promise<{ expiredReservations: number; expiredCarts: number; orphansReleased: number }> {
    if (this.running) {
      return { expiredReservations: 0, expiredCarts: 0, orphansReleased: 0 };
    }
    this.running = true;
    try {
      const expiredReservations = await this.expireReservations();
      const expiredCarts = await this.expireInactiveCarts();
      const orphansReleased = await this.releaseOrphans();
      await this.purgeMutations();
      if (expiredReservations > 0 || expiredCarts > 0 || orphansReleased > 0) {
        this.logger.log(
          `Sweep panier : ${expiredReservations} réservation(s) expirée(s), ${expiredCarts} panier(s) expiré(s), ${orphansReleased} orpheline(s) libérée(s).`,
        );
      }
      return { expiredReservations, expiredCarts, orphansReleased };
    } catch (error) {
      this.logger.error('Échec du sweep panier', error);
      return { expiredReservations: 0, expiredCarts: 0, orphansReleased: 0 };
    } finally {
      this.running = false;
    }
  }

  /**
   * Release IDEMPOTENTE d'une réservation dans une transaction : la transition
   * conditionnelle ACTIVE → target garantit qu'un double passage est un no-op.
   */
  private async releaseReservationTx(
    tx: Prisma.TransactionClient,
    reservation: {
      id: string;
      variantId: string;
      quantity: number;
      organizationId: string;
      shopId: string;
    },
    targetStatus: 'EXPIRED' | 'RELEASED',
    reason: string,
  ): Promise<boolean> {
    const transitioned = await tx.stockReservation.updateMany({
      where: { id: reservation.id, status: 'ACTIVE' },
      data: { status: targetStatus, releasedAt: new Date() },
    });
    if (transitioned.count !== 1) {
      return false;
    }
    const rows = await tx.$queryRaw<Array<{ quantityOnHand: number; quantityReserved: number }>>`
      UPDATE "inventory_items"
      SET "quantityReserved" = "quantityReserved" - ${reservation.quantity},
          "version" = "version" + 1,
          "updatedAt" = NOW()
      WHERE "variantId" = ${reservation.variantId}
      RETURNING "quantityOnHand", "quantityReserved"
    `;
    if (rows.length === 0) {
      throw new Error(`InventoryItem introuvable pour la variante ${reservation.variantId}`);
    }
    await tx.inventoryMovement.create({
      data: {
        organizationId: reservation.organizationId,
        shopId: reservation.shopId,
        variantId: reservation.variantId,
        type: 'RELEASE',
        quantityDelta: 0,
        quantityBefore: rows[0].quantityOnHand,
        quantityAfter: rows[0].quantityOnHand,
        quantityReservedBefore: rows[0].quantityReserved + reservation.quantity,
        quantityReservedAfter: rows[0].quantityReserved,
        referenceType: 'STOCK_RESERVATION',
        referenceId: reservation.id,
        reason,
      },
      select: { id: true },
    });
    return true;
  }

  private emitCartEvent(cart: {
    organizationId: string;
    shopId: string;
    conversationId: string;
    id: string;
    version: number;
  }, event: string): void {
    const payload: CartRealtimeEvent = {
      organizationId: cart.organizationId,
      shopId: cart.shopId,
      conversationId: cart.conversationId,
      cartId: cart.id,
      cartVersion: cart.version,
    };
    this.realtimeEmitter.emitToOrganization(cart.organizationId, event, payload);
  }

  // ------------------------------------------------------------ étape 1

  private async expireReservations(): Promise<number> {
    const now = new Date();
    const expired = await this.prisma.stockReservation.findMany({
      where: { status: 'ACTIVE', expiresAt: { lt: now } },
      take: SWEEP_BATCH_SIZE,
      select: {
        id: true,
        variantId: true,
        quantity: true,
        organizationId: true,
        shopId: true,
        cartId: true,
      },
    });

    const touchedCartIds = new Set<string>();
    let count = 0;
    for (const reservation of expired) {
      try {
        const applied = await this.prisma.$transaction((tx) =>
          this.releaseReservationTx(tx, reservation, 'EXPIRED', 'reservation expired'),
        );
        if (applied) {
          count += 1;
          touchedCartIds.add(reservation.cartId);
        }
      } catch (error) {
        this.logger.warn(`Expiration de la réservation ${reservation.id} échouée`, error);
      }
    }

    // Panier sans plus aucune réservation ACTIVE : retour à ACTIVE (checkout
    // non confirmé conservé — les données client ne sont pas perdues).
    for (const cartId of touchedCartIds) {
      const cart = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "carts" WHERE "id" = ${cartId} FOR UPDATE`;
        const remaining = await tx.stockReservation.count({
          where: { cartId, status: 'ACTIVE' },
        });
        if (remaining > 0) {
          return null;
        }
        const row = await tx.cart.findUnique({
          where: { id: cartId },
          select: {
            id: true,
            status: true,
            organizationId: true,
            shopId: true,
            conversationId: true,
            version: true,
            checkout: { select: { status: true } },
          },
        });
        if (!row || row.status !== 'CHECKOUT_STARTED' || row.checkout?.status === 'CONFIRMED') {
          return row;
        }
        await tx.cart.updateMany({
          where: { id: cartId, status: 'CHECKOUT_STARTED' },
          data: { status: 'ACTIVE', version: { increment: 1 } },
        });
        await tx.organizationAuditEvent.create({
          data: {
            organizationId: row.organizationId,
            eventType: 'STOCK_RELEASED',
            metadata: { cartId, reason: 'reservations expired' },
          },
          select: { id: true },
        });
        return tx.cart.findUnique({
          where: { id: cartId },
          select: {
            id: true,
            status: true,
            organizationId: true,
            shopId: true,
            conversationId: true,
            version: true,
            checkout: { select: { status: true } },
          },
        });
      });
      if (cart) {
        this.emitCartEvent(cart, SOCKET_EVENTS.CART_RESERVATION_UPDATED);
        this.emitCartEvent(cart, SOCKET_EVENTS.CART_UPDATED);
      }
    }
    return count;
  }

  // ------------------------------------------------------------ étape 2

  private async expireInactiveCarts(): Promise<number> {
    const now = new Date();
    const carts = await this.prisma.cart.findMany({
      where: {
        status: { in: ['ACTIVE', 'CHECKOUT_STARTED'] },
        expiresAt: { lt: now },
        // Un checkout CONFIRMED attend sa conversion en Order : jamais expiré ici.
        OR: [{ checkout: null }, { checkout: { status: { not: 'CONFIRMED' } } }],
      },
      take: SWEEP_BATCH_SIZE,
      select: { id: true, organizationId: true, shopId: true, conversationId: true },
    });

    let count = 0;
    for (const cartRef of carts) {
      try {
        const cart = await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "carts" WHERE "id" = ${cartRef.id} FOR UPDATE`;
          const transitioned = await tx.cart.updateMany({
            where: {
              id: cartRef.id,
              status: { in: ['ACTIVE', 'CHECKOUT_STARTED'] },
              expiresAt: { lt: new Date() },
            },
            data: { status: 'EXPIRED', version: { increment: 1 } },
          });
          if (transitioned.count !== 1) {
            return null; // déjà traité concurremment — idempotent
          }
          const reservations = await tx.stockReservation.findMany({
            where: { cartId: cartRef.id, status: 'ACTIVE' },
            select: { id: true, variantId: true, quantity: true, organizationId: true, shopId: true },
          });
          for (const reservation of reservations) {
            await this.releaseReservationTx(tx, reservation, 'EXPIRED', 'cart expired');
          }
          await tx.checkoutSession.updateMany({
            where: { cartId: cartRef.id, status: { notIn: ['CONFIRMED', 'CANCELLED'] } },
            data: { status: 'EXPIRED', version: { increment: 1 } },
          });
          await tx.organizationAuditEvent.create({
            data: {
              organizationId: cartRef.organizationId,
              eventType: 'CART_EXPIRED',
              metadata: { cartId: cartRef.id, releasedReservations: reservations.length },
            },
            select: { id: true },
          });
          return tx.cart.findUniqueOrThrow({
            where: { id: cartRef.id },
            select: {
              id: true,
              organizationId: true,
              shopId: true,
              conversationId: true,
              version: true,
            },
          });
        });
        if (cart) {
          count += 1;
          this.emitCartEvent(cart, SOCKET_EVENTS.CART_UPDATED);
        }
      } catch (error) {
        this.logger.warn(`Expiration du panier ${cartRef.id} échouée`, error);
      }
    }
    return count;
  }

  // ------------------------------------------------------------ étape 3

  /** Invariant "aucune réservation orpheline" — filet de sécurité, normalement mort. */
  private async releaseOrphans(): Promise<number> {
    const orphans = await this.prisma.stockReservation.findMany({
      where: {
        status: 'ACTIVE',
        cart: { status: { in: ['CONVERTED', 'ABANDONED', 'EXPIRED'] } },
      },
      take: SWEEP_BATCH_SIZE,
      select: { id: true, variantId: true, quantity: true, organizationId: true, shopId: true },
    });
    let count = 0;
    for (const orphan of orphans) {
      try {
        const applied = await this.prisma.$transaction((tx) =>
          this.releaseReservationTx(tx, orphan, 'RELEASED', 'orphan reservation (terminal cart)'),
        );
        if (applied) {
          count += 1;
          this.logger.warn(`Réservation orpheline libérée : ${orphan.id} (ne devrait pas arriver).`);
        }
      } catch (error) {
        this.logger.warn(`Release de l'orpheline ${orphan.id} échoué`, error);
      }
    }
    return count;
  }

  // ------------------------------------------------------------ étape 4

  private async purgeMutations(): Promise<void> {
    await this.prisma.cartMutation.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } },
    });
  }
}
