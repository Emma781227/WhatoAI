import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import {
  initialFulfillmentStatus,
  initialPaymentStatus,
  OrderCheckoutNotConfirmedError,
  OrderConcurrencyError,
  OrderConversionNotAllowedError,
  OrderReservationExpiredError,
  OrderReservationMismatchError,
  OrderReservationMissingError,
  OrderSnapshotInvalidError,
  SOCKET_EVENTS,
} from '@whauto/shared';
import type { OrderRealtimeEvent } from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import { CartsService } from '../carts/carts.service';
import { OrderSequenceService } from './order-sequence.service';
import { parseConfirmationSnapshot } from './order-snapshot';
import { OrderStockService } from './order-stock.service';
import { ORDER_DETAIL_SELECT } from './orders.mapper';
import type { OrderDetail } from './orders.mapper';

export interface ConvertInput {
  clientMutationId?: string;
  expectedCartVersion?: number;
  expectedCheckoutVersion?: number;
}

/**
 * Conversion ATOMIQUE Checkout CONFIRMED → Order (validé §8).
 * Le confirmationSnapshot stocké est l'UNIQUE source des données commerciales
 * et de la nature des lignes (physique/service/stock) — jamais le frontend,
 * jamais le catalogue courant (ajustements 3-4). Idempotence : structurelle
 * (cartId/checkoutSessionId uniques) + CartMutation (replay réseau).
 */
@Injectable()
export class OrderConversionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cartsService: CartsService,
    private readonly sequenceService: OrderSequenceService,
    private readonly stockService: OrderStockService,
    private readonly auditService: OrganizationAuditService,
    private readonly realtime: RealtimeService,
  ) {}

  async convert(
    tenant: TenantContext,
    conversationId: string,
    input: ConvertInput,
    context: AuditActionContext,
  ): Promise<{ order: OrderDetail; created: boolean }> {
    await this.cartsService.resolveConversation(tenant, conversationId, { writable: true });

    // Panier de la conversation en CHECKOUT_STARTED (le seul état convertible).
    const cartRef = await this.prisma.cart.findFirst({
      where: {
        conversationId,
        organizationId: tenant.organizationId,
        status: 'CHECKOUT_STARTED',
      },
      select: { id: true },
    });
    if (!cartRef) {
      // Déjà convertie ? Réponse idempotente : renvoyer l'Order existante.
      const existing = await this.findExistingOrder(tenant, conversationId);
      if (existing) {
        return { order: existing, created: false };
      }
      throw new OrderCheckoutNotConfirmedError();
    }

    try {
      const order = await this.prisma.$transaction(async (tx) => {
        // 1-2. Verrous — même ordre que CheckoutService (anti-deadlock).
        await tx.$queryRaw`SELECT "id" FROM "carts" WHERE "id" = ${cartRef.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "checkout_sessions" WHERE "cartId" = ${cartRef.id} FOR UPDATE`;
        await this.cartsService.claimMutation(tx, tenant, conversationId, input.clientMutationId);

        const cart = await tx.cart.findUniqueOrThrow({
          where: { id: cartRef.id },
          select: {
            id: true,
            status: true,
            version: true,
            organizationId: true,
            shopId: true,
            contactId: true,
            conversationId: true,
            checkout: {
              select: { id: true, status: true, version: true, confirmationSnapshot: true },
            },
            shop: {
              select: { id: true, organizationId: true, slug: true, orderNumberPrefix: true },
            },
          },
        });
        const checkout = cart.checkout;

        // 3-7. Vérifications d'état, de versions et de cohérence des IDs.
        if (!checkout || checkout.status !== 'CONFIRMED') {
          throw new OrderCheckoutNotConfirmedError();
        }
        const existingOrder = await tx.order.findUnique({
          where: { checkoutSessionId: checkout.id },
          select: { id: true },
        });
        if (existingOrder) {
          return tx.order.findUniqueOrThrow({
            where: { id: existingOrder.id },
            select: ORDER_DETAIL_SELECT,
          });
        }
        if (cart.status !== 'CHECKOUT_STARTED') {
          throw new OrderConversionNotAllowedError(`cart is ${cart.status}`);
        }
        if (checkout.confirmationSnapshot === null) {
          throw new OrderSnapshotInvalidError('snapshot is missing');
        }
        if (
          input.expectedCartVersion !== undefined &&
          input.expectedCartVersion !== cart.version
        ) {
          throw new OrderConcurrencyError();
        }
        if (
          input.expectedCheckoutVersion !== undefined &&
          input.expectedCheckoutVersion !== checkout.version
        ) {
          throw new OrderConcurrencyError();
        }

        const snapshot = parseConfirmationSnapshot(checkout.confirmationSnapshot);
        if (
          snapshot.cartId !== cart.id ||
          snapshot.checkoutSessionId !== checkout.id ||
          snapshot.organizationId !== cart.organizationId ||
          snapshot.shopId !== cart.shopId ||
          snapshot.contactId !== cart.contactId ||
          snapshot.conversationId !== cart.conversationId
        ) {
          throw new OrderSnapshotInvalidError('snapshot identifiers do not match the live entities');
        }

        // 8-10. Réservations : chaque ligne SUIVIE (d'après le SNAPSHOT) doit
        // porter une réservation ACTIVE non expirée de quantité EXACTE.
        const now = new Date();
        const activeReservations = await tx.stockReservation.findMany({
          where: { cartId: cart.id, status: 'ACTIVE' },
          select: { id: true, cartItemId: true, variantId: true, quantity: true, expiresAt: true },
        });
        const reservationByItem = new Map(
          activeReservations.map((reservation) => [reservation.cartItemId, reservation]),
        );
        const trackedLines = snapshot.lines.filter((line) => line.trackInventory);
        for (const line of trackedLines) {
          const reservation = reservationByItem.get(line.cartItemId);
          if (!reservation) {
            throw new OrderReservationMissingError();
          }
          if (reservation.expiresAt.getTime() <= now.getTime()) {
            throw new OrderReservationExpiredError();
          }
          if (reservation.quantity !== line.quantity) {
            throw new OrderReservationMismatchError();
          }
        }

        // 11. Numéro : préfixe stable de la Shop + séquence (Shop, année).
        const prefix = await this.sequenceService.ensurePrefix(tx, cart.shop);
        const orderNumber = await this.sequenceService.nextOrderNumber(tx, {
          shopId: cart.shopId,
          organizationId: cart.organizationId,
          prefix,
          now,
        });

        // 12. Order — champs commerciaux 100 % snapshot.
        const created = await tx.order.create({
          data: {
            organizationId: cart.organizationId,
            shopId: cart.shopId,
            contactId: cart.contactId,
            conversationId: cart.conversationId,
            cartId: cart.id,
            checkoutSessionId: checkout.id,
            orderNumber,
            status: 'CONFIRMED',
            paymentStatus: initialPaymentStatus(snapshot.paymentPreference),
            fulfillmentStatus: initialFulfillmentStatus(
              snapshot.lines.map((line) => line.productType),
            ),
            fulfillmentType: snapshot.fulfillmentType ?? 'PICKUP',
            currency: snapshot.currency,
            subtotalMinor: snapshot.subtotalMinor,
            discountMinor: snapshot.discountMinor,
            deliveryFeeMinor: snapshot.deliveryFeeMinor,
            totalMinor: snapshot.totalMinor,
            itemCount: snapshot.lines.reduce((sum, line) => sum + line.quantity, 0),
            customerName: snapshot.customer.name ?? '—',
            customerPhone: snapshot.customer.phone,
            customerEmail: snapshot.customer.email,
            addressLine1: snapshot.address.addressLine1,
            addressLine2: snapshot.address.addressLine2,
            city: snapshot.address.city,
            region: snapshot.address.region,
            postalCode: snapshot.address.postalCode,
            countryCode: snapshot.address.countryCode,
            landmark: snapshot.address.landmark,
            deliveryInstructions: snapshot.deliveryInstructions,
            paymentPreference: snapshot.paymentPreference,
            confirmedAt: now,
            createdByUserId: tenant.userId,
          },
          select: { id: true, paymentStatus: true, fulfillmentStatus: true },
        });

        // 13-18. Lignes + consommation backorder-aware + SALE + CONSUMED.
        let anyStockTouched = false;
        for (const line of snapshot.lines) {
          let consumedFromStock = 0;
          let backordered = 0;
          if (line.trackInventory) {
            const result = await this.stockService.consume(tx, {
              variantId: line.variantId,
              quantity: line.quantity,
            });
            consumedFromStock = result.consumedFromStock;
            backordered = result.backordered;
            anyStockTouched = true;
            await this.stockService.recordSale(tx, {
              organizationId: cart.organizationId,
              shopId: cart.shopId,
              variantId: line.variantId,
              orderId: created.id,
              counters: result.counters,
              consumedFromStock,
              actorUserId: tenant.userId,
            });
            const reservation = reservationByItem.get(line.cartItemId);
            const consumed = await tx.stockReservation.updateMany({
              where: { id: reservation?.id, status: 'ACTIVE' },
              data: { status: 'CONSUMED', consumedAt: now },
            });
            if (consumed.count !== 1) {
              throw new OrderReservationMissingError();
            }
          }
          await tx.orderItem.create({
            data: {
              organizationId: cart.organizationId,
              shopId: cart.shopId,
              orderId: created.id,
              productId: line.productId,
              variantId: line.variantId,
              productName: line.productName,
              variantName: line.variantName,
              sku: line.sku,
              imageUrl: line.imageUrl,
              optionValuesSnapshot: line.optionValues as Prisma.InputJsonValue,
              productTypeSnapshot: line.productType,
              trackInventorySnapshot: line.trackInventory,
              allowBackorderSnapshot: line.allowBackorder,
              quantity: line.quantity,
              unitPriceMinor: line.unitPriceMinor,
              compareAtPriceMinor: line.compareAtPriceMinor,
              lineSubtotalMinor: line.lineSubtotalMinor,
              currency: snapshot.currency,
              stockConsumedQuantity: consumedFromStock,
              backorderedQuantity: backordered,
            },
            select: { id: true },
          });
        }

        // 19-20. Cart → CONVERTED (transition conditionnelle).
        const converted = await tx.cart.updateMany({
          where: { id: cart.id, status: 'CHECKOUT_STARTED' },
          data: { status: 'CONVERTED', convertedAt: now, version: { increment: 1 } },
        });
        if (converted.count !== 1) {
          throw new OrderConcurrencyError();
        }

        // 21. Historique initial (SYSTEM).
        await tx.orderStatusHistory.create({
          data: {
            organizationId: cart.organizationId,
            shopId: cart.shopId,
            orderId: created.id,
            changeType: 'MULTIPLE',
            previousStatus: null,
            newStatus: 'CONFIRMED',
            previousPaymentStatus: null,
            newPaymentStatus: created.paymentStatus,
            previousFulfillmentStatus: null,
            newFulfillmentStatus: created.fulfillmentStatus,
            source: 'SYSTEM',
            actorUserId: tenant.userId,
          },
          select: { id: true },
        });

        // 22. Audit synthétique — dans la transaction.
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'ORDER_CREATED',
            actorUserId: tenant.userId,
            metadata: {
              orderId: created.id,
              orderNumber,
              cartId: cart.id,
              totalMinor: snapshot.totalMinor,
              itemCount: snapshot.lines.length,
            },
            context,
          },
          tx,
        );
        if (anyStockTouched) {
          await this.auditService.record(
            {
              organizationId: tenant.organizationId,
              eventType: 'ORDER_STOCK_CONSUMED',
              actorUserId: tenant.userId,
              metadata: { orderId: created.id, orderNumber },
              context,
            },
            tx,
          );
        }

        return tx.order.findUniqueOrThrow({
          where: { id: created.id },
          select: ORDER_DETAIL_SELECT,
        });
      });

      this.emitOrderEvent(order, SOCKET_EVENTS.ORDER_CREATED);
      return { order, created: true };
    } catch (error) {
      // Replay réseau (même clientMutationId) : renvoyer l'Order créée.
      if (this.cartsService.isDuplicateMutation(error)) {
        const existing = await this.findExistingOrder(tenant, conversationId);
        if (existing) {
          return { order: existing, created: false };
        }
      }
      throw error;
    }
  }

  private async findExistingOrder(
    tenant: TenantContext,
    conversationId: string,
  ): Promise<OrderDetail | null> {
    return this.prisma.order.findFirst({
      where: { conversationId, organizationId: tenant.organizationId },
      orderBy: { createdAt: 'desc' },
      select: ORDER_DETAIL_SELECT,
    });
  }

  emitOrderEvent(order: OrderDetail, event: string): void {
    const payload: OrderRealtimeEvent = {
      organizationId: order.organizationId,
      shopId: order.shopId,
      orderId: order.id,
      conversationId: order.conversationId,
      orderVersion: order.version,
    };
    this.realtime.emitToOrganization(order.organizationId, event, payload);
  }
}
