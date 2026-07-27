import { Injectable } from '@nestjs/common';
import type { Prisma } from '@whauto/database';
import {
  CartConcurrencyError,
  CartEmptyError,
  CartNotActiveError,
  CartRevalidationRequiredError,
  CheckoutAlreadyConfirmedError,
  CheckoutIncompleteError,
  CheckoutNotFoundError,
  computeCartTotals,
  missingCheckoutFields,
  SOCKET_EVENTS,
  StockReservationExpiredError,
  StockReservationFailedError,
} from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import { CART_DETAIL_SELECT } from './carts.mapper';
import type { CartDetail } from './carts.mapper';
import { CartsService } from './carts.service';
import { ReservationService } from './reservation.service';

export interface UpdateCheckoutInput {
  expectedVersion: number;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string;
  fulfillmentType?: 'DELIVERY' | 'PICKUP';
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  landmark?: string | null;
  deliveryInstructions?: string | null;
  paymentPreference?: 'CASH_ON_DELIVERY' | 'MOBILE_MONEY' | 'CARD' | 'PAY_IN_STORE' | 'UNDECIDED';
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cartsService: CartsService,
    private readonly reservationService: ReservationService,
    private readonly auditService: OrganizationAuditService,
  ) {}

  private async lockCartAndCheckout(tx: Prisma.TransactionClient, cartId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "carts" WHERE "id" = ${cartId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "checkout_sessions" WHERE "cartId" = ${cartId} FOR UPDATE`;
  }

  // -------------------------------------------------------------------- start

  /**
   * Démarrage du checkout — transaction TOUT-OU-RIEN (validé §17 ajusté) :
   * lock Cart → revalidation → réservations atomiques de TOUTES les lignes →
   * StockReservation + mouvements RESERVATION → CheckoutSession → transition
   * Cart → audit. Une seule ligne non réservable annule tout.
   */
  async start(
    tenant: TenantContext,
    conversationId: string,
    input: { expectedVersion?: number; clientMutationId?: string },
    context: AuditActionContext,
  ): Promise<CartDetail> {
    const scope = await this.cartsService.resolveConversation(tenant, conversationId, {
      writable: true,
    });
    const cartRef = await this.cartsService.requireOpenCartId(tenant, conversationId);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "carts" WHERE "id" = ${cartRef.id} FOR UPDATE`;
        await this.cartsService.claimMutation(tx, tenant, conversationId, input.clientMutationId);

        const cart = await tx.cart.findUniqueOrThrow({
          where: { id: cartRef.id },
          select: {
            id: true,
            status: true,
            version: true,
            itemCount: true,
            checkout: { select: { id: true, status: true } },
          },
        });
        if (cart.checkout?.status === 'CONFIRMED') {
          throw new CheckoutAlreadyConfirmedError();
        }
        if (cart.status !== 'ACTIVE') {
          throw new CartNotActiveError(cart.status); // double start protégé
        }
        if (input.expectedVersion !== undefined && input.expectedVersion !== cart.version) {
          throw new CartConcurrencyError();
        }

        const items = await tx.cartItem.findMany({
          where: { cartId: cart.id },
          select: {
            id: true,
            quantity: true,
            skuSnapshot: true,
            variantId: true,
            variant: { select: { trackInventory: true } },
          },
        });
        if (items.length === 0) {
          throw new CartEmptyError();
        }

        // Revalidation complète dans la transaction : toute ligne non-VALID bloque.
        const lines = await this.cartsService.revalidateLinesInTx(tx, cart.id);
        const invalid = lines.filter((line) => line.status !== 'VALID');
        if (invalid.length > 0) {
          throw new CartRevalidationRequiredError(
            invalid.map((line) => ({ cartItemId: line.cartItemId, status: line.status })),
          );
        }

        // Réservations atomiques — un échec lève et annule TOUT.
        const config = this.cartsService.reservationConfig();
        for (const item of items) {
          try {
            await this.reservationService.reserveForItem(tx, {
              organizationId: tenant.organizationId,
              shopId: scope.shopId,
              cartId: cart.id,
              cartItemId: item.id,
              variantId: item.variantId,
              quantity: item.quantity,
              trackInventory: item.variant.trackInventory,
              config,
              actorUserId: tenant.userId,
            });
          } catch {
            throw new StockReservationFailedError([
              { cartItemId: item.id, sku: item.skuSnapshot },
            ]);
          }
        }

        // Session : créée au premier start, RÉUTILISÉE (données client
        // conservées) après un cycle CANCELLED/EXPIRED.
        if (cart.checkout) {
          await tx.checkoutSession.update({
            where: { id: cart.checkout.id },
            data: { status: 'COLLECTING_INFORMATION', version: { increment: 1 } },
            select: { id: true },
          });
        } else {
          await tx.checkoutSession.create({
            data: {
              organizationId: tenant.organizationId,
              shopId: scope.shopId,
              cartId: cart.id,
              customerPhone: scope.contactPhone, // prérempli depuis le Contact (validé §13)
              customerName: scope.contactName,
            },
            select: { id: true },
          });
        }

        const transitioned = await tx.cart.updateMany({
          where: { id: cart.id, status: 'ACTIVE' },
          data: {
            status: 'CHECKOUT_STARTED',
            checkoutStartedAt: new Date(),
            version: { increment: 1 },
            lastActivityAt: new Date(),
          },
        });
        if (transitioned.count !== 1) {
          throw new CartNotActiveError('concurrent transition');
        }

        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'CHECKOUT_STARTED',
            actorUserId: tenant.userId,
            metadata: { cartId: cart.id, reservedLines: items.length },
            context,
          },
          tx,
        );
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'STOCK_RESERVED',
            actorUserId: tenant.userId,
            metadata: { cartId: cart.id, lineCount: items.length },
            context,
          },
          tx,
        );
        return tx.cart.findUniqueOrThrow({ where: { id: cart.id }, select: CART_DETAIL_SELECT });
      });
      this.cartsService.emitCartUpdated(result, SOCKET_EVENTS.CART_RESERVATION_UPDATED);
      this.cartsService.emitCartUpdated(result);
      return result;
    } catch (error) {
      if (this.cartsService.isDuplicateMutation(error)) {
        // Retry réseau du même start : renvoyer l'état courant, aucun double effet.
        return this.prisma.cart.findUniqueOrThrow({
          where: { id: cartRef.id },
          select: CART_DETAIL_SELECT,
        });
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- get/patch

  async get(tenant: TenantContext, conversationId: string): Promise<CartDetail> {
    const cart = await this.cartsService.getOpenCart(tenant, conversationId);
    if (!cart.checkout) {
      throw new CheckoutNotFoundError();
    }
    return cart;
  }

  /**
   * Collecte d'informations — action SIGNIFICATIVE : renouvelle les
   * réservations (throttle + plafond gérés par le service de réservation).
   */
  async update(
    tenant: TenantContext,
    conversationId: string,
    input: UpdateCheckoutInput,
    context: AuditActionContext,
  ): Promise<CartDetail> {
    await this.cartsService.resolveConversation(tenant, conversationId, { writable: true });
    const cartRef = await this.cartsService.requireOpenCartId(tenant, conversationId);

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockCartAndCheckout(tx, cartRef.id);
      const cart = await tx.cart.findUniqueOrThrow({
        where: { id: cartRef.id },
        select: { id: true, status: true, checkout: { select: { id: true, status: true, version: true } } },
      });
      if (!cart.checkout) {
        throw new CheckoutNotFoundError();
      }
      if (cart.checkout.status === 'CONFIRMED') {
        throw new CheckoutAlreadyConfirmedError();
      }
      if (cart.status !== 'CHECKOUT_STARTED') {
        throw new CartNotActiveError(cart.status);
      }
      // Deux onglets : verrou optimiste sur la SESSION (validé §16-17).
      if (input.expectedVersion !== cart.checkout.version) {
        throw new CartConcurrencyError();
      }

      const { expectedVersion, ...fields } = input;
      void expectedVersion; // déjà consommée par le contrôle de version ci-dessus
      const data: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) {
          data[key] = value;
        }
      }
      const updated = await tx.checkoutSession.update({
        where: { id: cart.checkout.id },
        data: { ...data, version: { increment: 1 } },
        select: {
          id: true,
          fulfillmentType: true,
          customerName: true,
          customerPhone: true,
          city: true,
          addressLine1: true,
          landmark: true,
          countryCode: true,
        },
      });

      // Statut dérivé de la complétude — READY_FOR_CONFIRMATION quand tout y est.
      const missing = missingCheckoutFields(updated);
      await tx.checkoutSession.update({
        where: { id: cart.checkout.id },
        data: {
          status: missing.length === 0 ? 'READY_FOR_CONFIRMATION' : 'COLLECTING_INFORMATION',
        },
        select: { id: true },
      });

      // Renouvellement contrôlé des réservations (action significative).
      const config = this.cartsService.reservationConfig();
      const reservations = await tx.stockReservation.findMany({
        where: { cartId: cart.id, status: 'ACTIVE' },
        select: { id: true, expiresAt: true, maxExpiresAt: true, lastRenewedAt: true, createdAt: true },
      });
      for (const reservation of reservations) {
        await this.reservationService.renewIfDue(tx, reservation, config);
      }

      await tx.cart.update({
        where: { id: cart.id },
        data: { version: { increment: 1 }, lastActivityAt: new Date() },
        select: { id: true },
      });
      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'CHECKOUT_UPDATED',
          actorUserId: tenant.userId,
          metadata: { cartId: cart.id, fields: Object.keys(data) },
          context,
        },
        tx,
      );
      return tx.cart.findUniqueOrThrow({ where: { id: cart.id }, select: CART_DETAIL_SELECT });
    });
    this.cartsService.emitCartUpdated(result, SOCKET_EVENTS.CHECKOUT_UPDATED);
    return result;
  }

  // ------------------------------------------------------------------ confirm

  /**
   * Confirmation ATOMIQUE (validé §19) : lock Cart+Session → expectedVersion →
   * revalidation lignes → réservations toutes ACTIVE et NON expirées →
   * recalcul serveur des totaux → validation DELIVERY/PICKUP →
   * confirmationSnapshot (UNE seule fois) → CONFIRMED → audit.
   */
  async confirm(
    tenant: TenantContext,
    conversationId: string,
    input: { expectedVersion: number; clientMutationId?: string },
    context: AuditActionContext,
  ): Promise<CartDetail> {
    await this.cartsService.resolveConversation(tenant, conversationId, { writable: true });
    const cartRef = await this.cartsService.requireOpenCartId(tenant, conversationId);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await this.lockCartAndCheckout(tx, cartRef.id);
        await this.cartsService.claimMutation(tx, tenant, conversationId, input.clientMutationId);

        const cart = await tx.cart.findUniqueOrThrow({
          where: { id: cartRef.id },
          select: CART_DETAIL_SELECT,
        });
        const checkout = cart.checkout;
        if (!checkout) {
          throw new CheckoutNotFoundError();
        }
        if (checkout.status === 'CONFIRMED') {
          throw new CheckoutAlreadyConfirmedError();
        }
        if (cart.status !== 'CHECKOUT_STARTED') {
          throw new CartNotActiveError(cart.status);
        }
        if (input.expectedVersion !== checkout.version) {
          throw new CartConcurrencyError();
        }

        // Validation DELIVERY/PICKUP (validé §13).
        const missing = missingCheckoutFields(checkout);
        if (missing.length > 0) {
          throw new CheckoutIncompleteError(missing);
        }

        // Revalidation des lignes dans la transaction.
        const lines = await this.cartsService.revalidateLinesInTx(tx, cart.id);
        const invalid = lines.filter((line) => line.status !== 'VALID');
        if (invalid.length > 0) {
          throw new CartRevalidationRequiredError(
            invalid.map((line) => ({ cartItemId: line.cartItemId, status: line.status })),
          );
        }

        // TOUTES les lignes à stock suivi doivent porter une réservation
        // ACTIVE non expirée — une expiration pendant la confirmation → 409
        // (les réservations n'existent que pour les variantes suivies).
        const trackedCount = await tx.cartItem.count({
          where: { cartId: cart.id, variant: { trackInventory: true } },
        });
        const now = new Date();
        const liveReservations = await tx.stockReservation.count({
          where: { cartId: cart.id, status: 'ACTIVE', expiresAt: { gt: now } },
        });
        if (liveReservations < trackedCount) {
          throw new StockReservationExpiredError();
        }

        // Totaux recalculés SERVEUR — jamais depuis le client.
        const totals = computeCartTotals(
          cart.items.map((item) => ({ unitPriceMinor: item.unitPriceMinor, quantity: item.quantity })),
          { discountMinor: cart.discountMinor, deliveryFeeMinor: cart.deliveryFeeMinor },
        );

        // Snapshot IMMUABLE — produit UNE SEULE FOIS, contrat de la conversion
        // en Order. La nature des lignes (productType/trackInventory/
        // allowBackorder) est GELÉE ICI : la conversion ne relit JAMAIS le
        // catalogue courant (validé — ajustement 3).
        const reservationRows = await tx.stockReservation.findMany({
          where: { cartId: cart.id, status: 'ACTIVE' },
          select: { id: true, cartItemId: true, quantity: true, expiresAt: true },
        });
        const variantNatures = await tx.cartItem.findMany({
          where: { cartId: cart.id },
          select: {
            id: true,
            compareAtPriceMinor: true,
            variant: {
              select: {
                trackInventory: true,
                allowBackorder: true,
                product: { select: { productType: true } },
              },
            },
          },
        });
        const natureByItemId = new Map(variantNatures.map((row) => [row.id, row]));
        const confirmationSnapshot = {
          cartId: cart.id,
          checkoutSessionId: checkout.id,
          conversationId: cart.conversationId,
          contactId: cart.contactId,
          shopId: cart.shopId,
          organizationId: cart.organizationId,
          currency: cart.currency,
          confirmedAt: now.toISOString(),
          cartVersion: cart.version + 1, // versions APRÈS cette confirmation
          checkoutVersion: checkout.version + 1,
          lines: cart.items.map((item) => {
            const nature = natureByItemId.get(item.id);
            return {
              cartItemId: item.id,
              productId: item.productId,
              variantId: item.variantId,
              productName: item.productNameSnapshot,
              variantName: item.variantNameSnapshot,
              sku: item.skuSnapshot,
              imageUrl: item.imageUrlSnapshot,
              optionValues: item.optionValuesSnapshot,
              unitPriceMinor: item.unitPriceMinor,
              compareAtPriceMinor: nature?.compareAtPriceMinor ?? null,
              quantity: item.quantity,
              lineSubtotalMinor: item.lineSubtotalMinor,
              productType: nature?.variant.product.productType ?? 'PHYSICAL',
              trackInventory: nature?.variant.trackInventory ?? true,
              allowBackorder: nature?.variant.allowBackorder ?? false,
            };
          }),
          subtotalMinor: totals.subtotalMinor,
          discountMinor: totals.discountMinor,
          deliveryFeeMinor: totals.deliveryFeeMinor,
          totalMinor: totals.totalMinor,
          fulfillmentType: checkout.fulfillmentType,
          customer: {
            name: checkout.customerName,
            phone: checkout.customerPhone,
            email: checkout.customerEmail,
          },
          address: {
            addressLine1: checkout.addressLine1,
            addressLine2: checkout.addressLine2,
            city: checkout.city,
            region: checkout.region,
            postalCode: checkout.postalCode,
            countryCode: checkout.countryCode,
            landmark: checkout.landmark,
          },
          deliveryInstructions: checkout.deliveryInstructions,
          paymentPreference: checkout.paymentPreference,
          reservations: reservationRows.map((reservation) => ({
            id: reservation.id,
            cartItemId: reservation.cartItemId,
            quantity: reservation.quantity,
            expiresAt: reservation.expiresAt.toISOString(),
          })),
        };

        const confirmed = await tx.checkoutSession.updateMany({
          where: { id: checkout.id, status: { in: ['COLLECTING_INFORMATION', 'READY_FOR_CONFIRMATION'] } },
          data: {
            status: 'CONFIRMED',
            completedAt: now,
            confirmationSnapshot,
            version: { increment: 1 },
          },
        });
        if (confirmed.count !== 1) {
          throw new CartConcurrencyError();
        }
        await tx.cart.update({
          where: { id: cart.id },
          data: {
            subtotalMinor: totals.subtotalMinor,
            totalMinor: totals.totalMinor,
            itemCount: totals.itemCount,
            version: { increment: 1 },
            lastActivityAt: now,
          },
          select: { id: true },
        });
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'CHECKOUT_CONFIRMED',
            actorUserId: tenant.userId,
            metadata: {
              cartId: cart.id,
              totalMinor: totals.totalMinor,
              fulfillmentType: checkout.fulfillmentType,
            },
            context,
          },
          tx,
        );
        return tx.cart.findUniqueOrThrow({ where: { id: cart.id }, select: CART_DETAIL_SELECT });
      });
      this.cartsService.emitCartUpdated(result, SOCKET_EVENTS.CHECKOUT_CONFIRMED);
      return result;
    } catch (error) {
      if (this.cartsService.isDuplicateMutation(error)) {
        return this.prisma.cart.findUniqueOrThrow({
          where: { id: cartRef.id },
          select: CART_DETAIL_SELECT,
        });
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------- cancel

  /** Annulation : release de toutes les réservations, Cart → ACTIVE, session CANCELLED. */
  async cancel(
    tenant: TenantContext,
    conversationId: string,
    context: AuditActionContext,
  ): Promise<CartDetail> {
    await this.cartsService.resolveConversation(tenant, conversationId, { writable: true });
    const cartRef = await this.cartsService.requireOpenCartId(tenant, conversationId);

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockCartAndCheckout(tx, cartRef.id);
      const cart = await tx.cart.findUniqueOrThrow({
        where: { id: cartRef.id },
        select: { id: true, status: true, checkout: { select: { id: true, status: true } } },
      });
      if (!cart.checkout) {
        throw new CheckoutNotFoundError();
      }
      if (cart.checkout.status === 'CONFIRMED') {
        throw new CheckoutAlreadyConfirmedError();
      }
      if (cart.status !== 'CHECKOUT_STARTED') {
        throw new CartNotActiveError(cart.status);
      }

      const reservations = await tx.stockReservation.findMany({
        where: { cartId: cart.id, status: 'ACTIVE' },
        select: { id: true, variantId: true, quantity: true, organizationId: true, shopId: true },
      });
      for (const reservation of reservations) {
        await this.reservationService.releaseReservation(tx, reservation, 'CANCELLED', 'checkout cancelled');
      }
      await tx.checkoutSession.update({
        where: { id: cart.checkout.id },
        data: { status: 'CANCELLED', version: { increment: 1 } },
        select: { id: true },
      });
      await tx.cart.updateMany({
        where: { id: cart.id, status: 'CHECKOUT_STARTED' },
        data: { status: 'ACTIVE', version: { increment: 1 }, lastActivityAt: new Date() },
      });
      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'STOCK_RELEASED',
          actorUserId: tenant.userId,
          metadata: { cartId: cart.id, releasedReservations: reservations.length, reason: 'checkout cancelled' },
          context,
        },
        tx,
      );
      return tx.cart.findUniqueOrThrow({ where: { id: cart.id }, select: CART_DETAIL_SELECT });
    });
    this.cartsService.emitCartUpdated(result, SOCKET_EVENTS.CART_RESERVATION_UPDATED);
    this.cartsService.emitCartUpdated(result, SOCKET_EVENTS.CHECKOUT_UPDATED);
    return result;
  }
}
