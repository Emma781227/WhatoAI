import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@whauto/database';
import {
  buildCartSummaryText,
  CartConcurrencyError,
  CartCurrencyMismatchError,
  CartEmptyError,
  CartInsufficientStockError,
  CartItemNotFoundError,
  CartNotActiveError,
  CartNotFoundError,
  CartPriceChangedError,
  CartProductUnavailableError,
  CheckoutAlreadyConfirmedError,
  computeCartTotals,
  computeLineSubtotal,
  ConversationNotFoundError,
  revalidateCartLine,
  ShopArchivedError,
  SOCKET_EVENTS,
  ValidationError,
  VariantNotFoundError,
} from '@whauto/shared';
import type { CartRealtimeEvent, LineRevalidationResult } from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import { CART_DETAIL_SELECT, earliestReservationExpiry } from './carts.mapper';
import type { CartDetail } from './carts.mapper';
import { ReservationService } from './reservation.service';
import type { ReservationConfig } from './reservation.service';

export interface ConversationScope {
  conversationId: string;
  shopId: string;
  contactId: string;
  shopStatus: string;
  currency: string;
  contactPhone: string;
  contactName: string | null;
}

export interface LineRevalidationDetail extends LineRevalidationResult {
  cartItemId: string;
}

const OPEN_STATUSES = ['ACTIVE', 'CHECKOUT_STARTED'] as const;

function isUniqueViolation(error: unknown, column?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  if (column === undefined) {
    return true;
  }
  const target = error.meta?.target;
  return Array.isArray(target) && target.includes(column);
}

@Injectable()
export class CartsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationService: ReservationService,
    private readonly auditService: OrganizationAuditService,
    private readonly realtime: RealtimeService,
    private readonly configService: ConfigService,
  ) {}

  reservationConfig(): ReservationConfig {
    return {
      ttlMinutes: this.configService.get<number>('STOCK_RESERVATION_TTL_MINUTES') ?? 15,
      maxLifetimeMinutes:
        this.configService.get<number>('STOCK_RESERVATION_MAX_LIFETIME_MINUTES') ?? 60,
      renewalMinIntervalSeconds:
        this.configService.get<number>('STOCK_RESERVATION_RENEWAL_MIN_INTERVAL_SECONDS') ?? 60,
    };
  }

  private inactivityExpiry(): Date {
    const ttl = this.configService.get<number>('CART_INACTIVITY_TTL_MINUTES') ?? 120;
    return new Date(Date.now() + ttl * 60_000);
  }

  // ---------------------------------------------------------------- scope

  async resolveConversation(
    tenant: TenantContext,
    conversationId: string,
    options: { writable: boolean },
  ): Promise<ConversationScope> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: tenant.organizationId },
      select: {
        id: true,
        shopId: true,
        contactId: true,
        shop: { select: { status: true, currency: true } },
        contact: { select: { whatsappPhone: true, displayName: true } },
      },
    });
    if (!conversation) {
      throw new ConversationNotFoundError();
    }
    if (options.writable && conversation.shop.status === 'ARCHIVED') {
      throw new ShopArchivedError();
    }
    return {
      conversationId: conversation.id,
      shopId: conversation.shopId,
      contactId: conversation.contactId,
      shopStatus: conversation.shop.status,
      currency: conversation.shop.currency,
      contactPhone: conversation.contact.whatsappPhone,
      contactName: conversation.contact.displayName,
    };
  }

  async getOpenCart(tenant: TenantContext, conversationId: string): Promise<CartDetail> {
    await this.resolveConversation(tenant, conversationId, { writable: false });
    const cart = await this.prisma.cart.findFirst({
      where: {
        conversationId,
        organizationId: tenant.organizationId,
        status: { in: [...OPEN_STATUSES] },
      },
      select: CART_DETAIL_SELECT,
    });
    if (!cart) {
      throw new CartNotFoundError();
    }
    return cart;
  }

  // ------------------------------------------------------------ helpers tx

  /** Verrou pessimiste : sérialise TOUTES les mutations d'un même panier. */
  private async lockCart(tx: Prisma.TransactionClient, cartId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "carts" WHERE "id" = ${cartId} FOR UPDATE`;
  }

  /**
   * Idempotence ciblée (validé §21) : l'insertion dans la MÊME transaction
   * déduplique — un P2002 sur (conversationId, clientMutationId) signifie
   * "déjà appliqué", l'appelant renvoie l'état courant sans double effet.
   */
  async claimMutation(
    tx: Prisma.TransactionClient,
    tenant: TenantContext,
    conversationId: string,
    clientMutationId: string | undefined,
  ): Promise<void> {
    if (clientMutationId === undefined) {
      return;
    }
    await tx.cartMutation.create({
      data: { organizationId: tenant.organizationId, conversationId, clientMutationId },
      select: { id: true },
    });
  }

  isDuplicateMutation(error: unknown): boolean {
    return isUniqueViolation(error, 'clientMutationId');
  }

  private assertMutable(cart: {
    status: string;
    version: number;
    checkout: { status: string } | null;
  }): void {
    if (cart.checkout?.status === 'CONFIRMED') {
      throw new CheckoutAlreadyConfirmedError();
    }
    if (!OPEN_STATUSES.includes(cart.status as (typeof OPEN_STATUSES)[number])) {
      throw new CartNotActiveError(cart.status);
    }
  }

  private assertVersion(cart: { version: number }, expectedVersion: number | undefined): void {
    if (expectedVersion !== undefined && expectedVersion !== cart.version) {
      throw new CartConcurrencyError();
    }
  }

  /** Recalcule totaux + compteurs et incrémente la version — dans la transaction. */
  private async recalcAndTouch(tx: Prisma.TransactionClient, cartId: string): Promise<void> {
    const items = await tx.cartItem.findMany({
      where: { cartId },
      select: { unitPriceMinor: true, quantity: true },
    });
    let totals;
    try {
      totals = computeCartTotals(items);
    } catch {
      throw new ValidationError('Cart total exceeds the maximum representable amount.');
    }
    await tx.cart.update({
      where: { id: cartId },
      data: {
        subtotalMinor: totals.subtotalMinor,
        totalMinor: totals.totalMinor,
        itemCount: totals.itemCount,
        version: { increment: 1 },
        lastActivityAt: new Date(),
        expiresAt: this.inactivityExpiry(),
      },
      select: { id: true },
    });
  }

  private async reloadCart(clientOrTx: Prisma.TransactionClient, cartId: string): Promise<CartDetail> {
    return clientOrTx.cart.findUniqueOrThrow({ where: { id: cartId }, select: CART_DETAIL_SELECT });
  }

  emitCartUpdated(cart: CartDetail, event: string = SOCKET_EVENTS.CART_UPDATED): void {
    const payload: CartRealtimeEvent = {
      organizationId: cart.organizationId,
      shopId: cart.shopId,
      conversationId: cart.conversationId,
      cartId: cart.id,
      cartVersion: cart.version,
    };
    this.realtime.emitToOrganization(cart.organizationId, event, payload);
  }

  // ------------------------------------------------------------ create/get

  /** POST /cart explicite — idempotent : renvoie l'ouvert existant. */
  async createCart(
    tenant: TenantContext,
    conversationId: string,
    context: AuditActionContext,
  ): Promise<CartDetail> {
    const scope = await this.resolveConversation(tenant, conversationId, { writable: true });
    const existing = await this.prisma.cart.findFirst({
      where: { conversationId, status: { in: [...OPEN_STATUSES] } },
      select: CART_DETAIL_SELECT,
    });
    if (existing) {
      return existing;
    }
    return this.createCartRow(tenant, scope, context);
  }

  private async createCartRow(
    tenant: TenantContext,
    scope: ConversationScope,
    context: AuditActionContext,
  ): Promise<CartDetail> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const cart = await tx.cart.create({
          data: {
            organizationId: tenant.organizationId,
            shopId: scope.shopId,
            contactId: scope.contactId,
            conversationId: scope.conversationId,
            currency: scope.currency,
            expiresAt: this.inactivityExpiry(),
          },
          select: { id: true },
        });
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'CART_CREATED',
            actorUserId: tenant.userId,
            metadata: { cartId: cart.id, conversationId: scope.conversationId, shopId: scope.shopId },
            context,
          },
          tx,
        );
        return this.reloadCart(tx, cart.id);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Création concurrente : l'index partiel a tranché — réutiliser.
        const existing = await this.prisma.cart.findFirst({
          where: { conversationId: scope.conversationId, status: { in: [...OPEN_STATUSES] } },
          select: CART_DETAIL_SELECT,
        });
        if (existing) {
          return existing;
        }
      }
      throw error;
    }
  }

  // ------------------------------------------------------------ mutations

  /**
   * Ajout d'une variante — crée le panier au premier ajout (validé). Ajout
   * d'une variante déjà présente = INCRÉMENT de quantité (validé), protégé
   * par le verrou du panier + @@unique(cartId, variantId).
   */
  async addItem(
    tenant: TenantContext,
    conversationId: string,
    input: {
      variantId: string;
      quantity: number;
      expectedVersion?: number;
      clientMutationId?: string;
    },
    context: AuditActionContext,
  ): Promise<CartDetail> {
    const scope = await this.resolveConversation(tenant, conversationId, { writable: true });

    // Revalidation catalogue FRAÎCHE au moment de l'ajout (validé §7).
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: input.variantId, organizationId: tenant.organizationId, shopId: scope.shopId },
      select: {
        id: true,
        status: true,
        name: true,
        sku: true,
        priceMinor: true,
        compareAtPriceMinor: true,
        trackInventory: true,
        allowBackorder: true,
        productId: true,
        product: {
          select: {
            status: true,
            name: true,
            currency: true,
            images: { select: { url: true, isPrimary: true }, orderBy: { position: 'asc' as const }, take: 1 },
          },
        },
        optionValues: {
          select: {
            option: { select: { name: true, position: true } },
            optionValue: { select: { value: true } },
          },
        },
        inventory: { select: { quantityOnHand: true, quantityReserved: true } },
      },
    });
    if (!variant) {
      throw new VariantNotFoundError();
    }
    if (variant.product.status !== 'ACTIVE' || variant.status !== 'ACTIVE') {
      throw new CartProductUnavailableError();
    }
    if (variant.product.currency !== scope.currency) {
      throw new CartCurrencyMismatchError();
    }

    let cart = await this.prisma.cart.findFirst({
      where: { conversationId, status: { in: [...OPEN_STATUSES] } },
      select: { id: true },
    });
    if (!cart) {
      cart = { id: (await this.createCartRow(tenant, scope, context)).id };
    }
    const cartId = cart.id;

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await this.lockCart(tx, cartId);
        await this.claimMutation(tx, tenant, conversationId, input.clientMutationId);

        const current = await tx.cart.findUniqueOrThrow({
          where: { id: cartId },
          select: { status: true, version: true, checkout: { select: { status: true } } },
        });
        this.assertMutable(current);
        this.assertVersion(current, input.expectedVersion);

        const existingItem = await tx.cartItem.findUnique({
          where: { cartId_variantId: { cartId, variantId: variant.id } },
          select: {
            id: true,
            quantity: true,
            reservations: {
              where: { status: 'ACTIVE' },
              select: { id: true, variantId: true, organizationId: true, shopId: true },
            },
          },
        });
        const newQuantity = (existingItem?.quantity ?? 0) + input.quantity;
        if (newQuantity > 999) {
          throw new ValidationError('Maximum quantity per line is 999.');
        }

        // Disponibilité à l'ajout : le stock DISPONIBLE doit couvrir la
        // quantité totale demandée (hors backorder). Les réservations de CE
        // panier pour cette ligne ne comptent pas comme "pris".
        if (variant.trackInventory && !variant.allowBackorder) {
          const ownReserved = existingItem?.reservations.length ? existingItem.quantity : 0;
          const available =
            (variant.inventory?.quantityOnHand ?? 0) -
            (variant.inventory?.quantityReserved ?? 0) +
            ownReserved;
          if (available < newQuantity && current.status === 'ACTIVE') {
            throw new CartInsufficientStockError();
          }
        }

        let itemId: string;
        if (existingItem) {
          itemId = existingItem.id;
          await tx.cartItem.update({
            where: { id: existingItem.id },
            data: {
              quantity: newQuantity,
              lineSubtotalMinor: computeLineSubtotal(
                (await tx.cartItem.findUniqueOrThrow({
                  where: { id: existingItem.id },
                  select: { unitPriceMinor: true },
                })).unitPriceMinor,
                newQuantity,
              ),
              version: { increment: 1 },
            },
            select: { id: true },
          });
          // Panier réservé : réserver UNIQUEMENT la différence (validé §18) —
          // un échec annule toute la transaction.
          if (current.status === 'CHECKOUT_STARTED' && existingItem.reservations[0]) {
            await this.reservationService.adjustActiveReservation(
              tx,
              existingItem.reservations[0],
              input.quantity,
              tenant.userId,
            );
          }
        } else {
          const optionValues = variant.optionValues
            .slice()
            .sort((a, b) => a.option.position - b.option.position)
            .map((link) => [link.option.name, link.optionValue.value]);
          const created = await tx.cartItem.create({
            data: {
              organizationId: tenant.organizationId,
              shopId: scope.shopId,
              cartId,
              productId: variant.productId,
              variantId: variant.id,
              quantity: input.quantity,
              unitPriceMinor: variant.priceMinor,
              compareAtPriceMinor: variant.compareAtPriceMinor,
              lineSubtotalMinor: computeLineSubtotal(variant.priceMinor, input.quantity),
              productNameSnapshot: variant.product.name,
              variantNameSnapshot: variant.name,
              skuSnapshot: variant.sku,
              imageUrlSnapshot: variant.product.images[0]?.url ?? null,
              optionValuesSnapshot: optionValues.length > 0 ? optionValues : Prisma.JsonNull,
              currentPriceMinor: variant.priceMinor,
            },
            select: { id: true },
          });
          itemId = created.id;
          if (current.status === 'CHECKOUT_STARTED') {
            await this.reservationService.reserveForItem(tx, {
              organizationId: tenant.organizationId,
              shopId: scope.shopId,
              cartId,
              cartItemId: created.id,
              variantId: variant.id,
              quantity: input.quantity,
              trackInventory: variant.trackInventory,
              config: this.reservationConfig(),
              actorUserId: tenant.userId,
            });
          }
        }

        await this.recalcAndTouch(tx, cartId);
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'CART_ITEM_ADDED',
            actorUserId: tenant.userId,
            metadata: { cartId, cartItemId: itemId, variantId: variant.id, quantity: input.quantity },
            context,
          },
          tx,
        );
        return this.reloadCart(tx, cartId);
      });
      this.emitCartUpdated(result);
      return result;
    } catch (error) {
      if (this.isDuplicateMutation(error)) {
        return this.reloadCart(this.prisma, cartId); // retry réseau : aucun double effet
      }
      throw error;
    }
  }

  async updateItemQuantity(
    tenant: TenantContext,
    conversationId: string,
    cartItemId: string,
    input: { quantity: number; expectedVersion?: number; clientMutationId?: string },
    context: AuditActionContext,
  ): Promise<CartDetail> {
    await this.resolveConversation(tenant, conversationId, { writable: true });
    const cart = await this.requireOpenCartId(tenant, conversationId);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await this.lockCart(tx, cart.id);
        await this.claimMutation(tx, tenant, conversationId, input.clientMutationId);

        const current = await tx.cart.findUniqueOrThrow({
          where: { id: cart.id },
          select: { status: true, version: true, checkout: { select: { status: true } } },
        });
        this.assertMutable(current);
        this.assertVersion(current, input.expectedVersion);

        const item = await tx.cartItem.findFirst({
          where: { id: cartItemId, cartId: cart.id },
          select: {
            id: true,
            quantity: true,
            unitPriceMinor: true,
            variantId: true,
            variant: { select: { trackInventory: true } },
            reservations: {
              where: { status: 'ACTIVE' },
              select: { id: true, variantId: true, organizationId: true, shopId: true },
            },
          },
        });
        if (!item) {
          throw new CartItemNotFoundError();
        }
        const delta = input.quantity - item.quantity;
        if (delta === 0) {
          throw new ValidationError('The quantity is unchanged.');
        }

        await tx.cartItem.update({
          where: { id: item.id },
          data: {
            quantity: input.quantity,
            lineSubtotalMinor: computeLineSubtotal(item.unitPriceMinor, input.quantity),
            version: { increment: 1 },
          },
          select: { id: true },
        });

        // Panier réservé : delta réservé/libéré atomiquement (validé §18).
        if (current.status === 'CHECKOUT_STARTED' && item.reservations[0]) {
          await this.reservationService.adjustActiveReservation(
            tx,
            item.reservations[0],
            delta,
            tenant.userId,
          );
        }

        await this.recalcAndTouch(tx, cart.id);
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'CART_ITEM_UPDATED',
            actorUserId: tenant.userId,
            metadata: { cartId: cart.id, cartItemId, quantity: input.quantity, delta },
            context,
          },
          tx,
        );
        return this.reloadCart(tx, cart.id);
      });
      this.emitCartUpdated(result);
      return result;
    } catch (error) {
      if (this.isDuplicateMutation(error)) {
        return this.reloadCart(this.prisma, cart.id);
      }
      throw error;
    }
  }

  async removeItem(
    tenant: TenantContext,
    conversationId: string,
    cartItemId: string,
    input: { expectedVersion?: number },
    context: AuditActionContext,
  ): Promise<CartDetail> {
    await this.resolveConversation(tenant, conversationId, { writable: true });
    const cart = await this.requireOpenCartId(tenant, conversationId);

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, cart.id);
      const current = await tx.cart.findUniqueOrThrow({
        where: { id: cart.id },
        select: { status: true, version: true, checkout: { select: { status: true } } },
      });
      this.assertMutable(current);
      this.assertVersion(current, input.expectedVersion);

      const item = await tx.cartItem.findFirst({
        where: { id: cartItemId, cartId: cart.id },
        select: {
          id: true,
          reservations: {
            where: { status: 'ACTIVE' },
            select: { id: true, variantId: true, quantity: true, organizationId: true, shopId: true },
          },
        },
      });
      if (!item) {
        throw new CartItemNotFoundError();
      }

      // Release COMPLET avant suppression de la ligne (validé §18).
      for (const reservation of item.reservations) {
        await this.reservationService.releaseReservation(tx, reservation, 'RELEASED', 'item removed');
      }
      await tx.cartItem.delete({ where: { id: item.id }, select: { id: true } });

      await this.recalcAndTouch(tx, cart.id);
      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'CART_ITEM_REMOVED',
          actorUserId: tenant.userId,
          metadata: { cartId: cart.id, cartItemId },
          context,
        },
        tx,
      );
      return this.reloadCart(tx, cart.id);
    });
    this.emitCartUpdated(result);
    return result;
  }

  async clear(
    tenant: TenantContext,
    conversationId: string,
    input: { expectedVersion?: number },
    context: AuditActionContext,
  ): Promise<CartDetail> {
    await this.resolveConversation(tenant, conversationId, { writable: true });
    const cart = await this.requireOpenCartId(tenant, conversationId);

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, cart.id);
      const current = await tx.cart.findUniqueOrThrow({
        where: { id: cart.id },
        select: { status: true, version: true, checkout: { select: { status: true } } },
      });
      this.assertMutable(current);
      this.assertVersion(current, input.expectedVersion);

      // Release de TOUTES les réservations AVANT suppression (validé §18).
      const reservations = await tx.stockReservation.findMany({
        where: { cartId: cart.id, status: 'ACTIVE' },
        select: { id: true, variantId: true, quantity: true, organizationId: true, shopId: true },
      });
      for (const reservation of reservations) {
        await this.reservationService.releaseReservation(tx, reservation, 'RELEASED', 'cart cleared');
      }
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      await this.recalcAndTouch(tx, cart.id);
      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'CART_CLEARED',
          actorUserId: tenant.userId,
          metadata: { cartId: cart.id },
          context,
        },
        tx,
      );
      return this.reloadCart(tx, cart.id);
    });
    this.emitCartUpdated(result);
    return result;
  }

  // ---------------------------------------------------------- revalidation

  /**
   * Revalidation complète (validé §7) : statuts persistés par ligne, JAMAIS
   * de correction silencieuse — PRICE_CHANGED attend accept-current-price,
   * QUANTITY_REDUCED_REQUIRED attend une modification explicite.
   */
  async revalidate(
    tenant: TenantContext,
    conversationId: string,
  ): Promise<{ cart: CartDetail; lines: LineRevalidationDetail[] }> {
    await this.resolveConversation(tenant, conversationId, { writable: false });
    const cart = await this.requireOpenCartId(tenant, conversationId);

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, cart.id);
      const lines = await this.revalidateLinesInTx(tx, cart.id);
      await tx.cart.update({
        where: { id: cart.id },
        data: { version: { increment: 1 } },
        select: { id: true },
      });
      return { cart: await this.reloadCart(tx, cart.id), lines };
    });
    this.emitCartUpdated(result.cart);
    return result;
  }

  /** Revalide et PERSISTE les statuts de toutes les lignes — dans la transaction appelante. */
  async revalidateLinesInTx(
    tx: Prisma.TransactionClient,
    cartId: string,
  ): Promise<LineRevalidationDetail[]> {
    const items = await tx.cartItem.findMany({
      where: { cartId },
      select: {
        id: true,
        quantity: true,
        unitPriceMinor: true,
        variant: {
          select: {
            status: true,
            priceMinor: true,
            trackInventory: true,
            allowBackorder: true,
            product: { select: { status: true } },
            inventory: { select: { quantityOnHand: true, quantityReserved: true } },
          },
        },
        reservations: { where: { status: 'ACTIVE' }, select: { quantity: true } },
      },
    });

    const results: LineRevalidationDetail[] = [];
    for (const item of items) {
      const result = revalidateCartLine({
        productStatus: item.variant.product.status,
        variantStatus: item.variant.status,
        snapshotUnitPriceMinor: item.unitPriceMinor,
        currentPriceMinor: item.variant.priceMinor,
        quantity: item.quantity,
        trackInventory: item.variant.trackInventory,
        allowBackorder: item.variant.allowBackorder,
        quantityOnHand: item.variant.inventory?.quantityOnHand ?? 0,
        quantityReserved: item.variant.inventory?.quantityReserved ?? 0,
        reservedByThisLine: item.reservations[0]?.quantity ?? 0,
      });
      await tx.cartItem.update({
        where: { id: item.id },
        data: { availabilityStatus: result.status, currentPriceMinor: result.currentPriceMinor },
        select: { id: true },
      });
      results.push({ cartItemId: item.id, ...result });
    }
    return results;
  }

  /** Résolution EXPLICITE d'un PRICE_CHANGED (validé) — jamais silencieuse. */
  async acceptCurrentPrice(
    tenant: TenantContext,
    conversationId: string,
    cartItemId: string,
    input: { expectedVersion?: number },
    context: AuditActionContext,
  ): Promise<CartDetail> {
    await this.resolveConversation(tenant, conversationId, { writable: true });
    const cart = await this.requireOpenCartId(tenant, conversationId);

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockCart(tx, cart.id);
      const current = await tx.cart.findUniqueOrThrow({
        where: { id: cart.id },
        select: { status: true, version: true, checkout: { select: { status: true } } },
      });
      this.assertMutable(current);
      this.assertVersion(current, input.expectedVersion);

      const item = await tx.cartItem.findFirst({
        where: { id: cartItemId, cartId: cart.id },
        select: {
          id: true,
          quantity: true,
          unitPriceMinor: true,
          variant: { select: { priceMinor: true, compareAtPriceMinor: true, status: true, product: { select: { status: true } } } },
        },
      });
      if (!item) {
        throw new CartItemNotFoundError();
      }
      if (item.variant.product.status !== 'ACTIVE' || item.variant.status !== 'ACTIVE') {
        throw new CartProductUnavailableError();
      }
      if (item.variant.priceMinor === item.unitPriceMinor) {
        throw new CartPriceChangedError(); // rien à accepter — état incohérent côté client
      }

      await tx.cartItem.update({
        where: { id: item.id },
        data: {
          unitPriceMinor: item.variant.priceMinor,
          compareAtPriceMinor: item.variant.compareAtPriceMinor,
          currentPriceMinor: item.variant.priceMinor,
          lineSubtotalMinor: computeLineSubtotal(item.variant.priceMinor, item.quantity),
          availabilityStatus: 'VALID',
          version: { increment: 1 },
        },
        select: { id: true },
      });
      await this.recalcAndTouch(tx, cart.id);
      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'CART_ITEM_UPDATED',
          actorUserId: tenant.userId,
          metadata: {
            cartId: cart.id,
            cartItemId,
            priceAccepted: true,
            from: item.unitPriceMinor,
            to: item.variant.priceMinor,
          },
          context,
        },
        tx,
      );
      return this.reloadCart(tx, cart.id);
    });
    this.emitCartUpdated(result);
    return result;
  }

  // -------------------------------------------------------------- abandon

  async abandon(
    tenant: TenantContext,
    conversationId: string,
    input: { clientMutationId?: string },
    context: AuditActionContext,
  ): Promise<CartDetail> {
    await this.resolveConversation(tenant, conversationId, { writable: true });
    const cart = await this.requireOpenCartId(tenant, conversationId);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await this.lockCart(tx, cart.id);
        await this.claimMutation(tx, tenant, conversationId, input.clientMutationId);
        const current = await tx.cart.findUniqueOrThrow({
          where: { id: cart.id },
          select: { status: true, version: true, checkout: { select: { id: true, status: true } } },
        });
        this.assertMutable(current);

        const reservations = await tx.stockReservation.findMany({
          where: { cartId: cart.id, status: 'ACTIVE' },
          select: { id: true, variantId: true, quantity: true, organizationId: true, shopId: true },
        });
        for (const reservation of reservations) {
          await this.reservationService.releaseReservation(tx, reservation, 'CANCELLED', 'cart abandoned');
        }
        const transitioned = await tx.cart.updateMany({
          where: { id: cart.id, status: { in: [...OPEN_STATUSES] } },
          data: { status: 'ABANDONED', abandonedAt: new Date(), version: { increment: 1 } },
        });
        if (transitioned.count !== 1) {
          throw new CartNotActiveError('terminal');
        }
        if (current.checkout && current.checkout.status !== 'CONFIRMED') {
          await tx.checkoutSession.updateMany({
            where: { id: current.checkout.id, status: { notIn: ['CONFIRMED'] } },
            data: { status: 'CANCELLED', version: { increment: 1 } },
          });
        }
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'CART_ABANDONED',
            actorUserId: tenant.userId,
            metadata: { cartId: cart.id, releasedReservations: reservations.length },
            context,
          },
          tx,
        );
        return this.reloadCart(tx, cart.id);
      });
      this.emitCartUpdated(result);
      return result;
    } catch (error) {
      if (this.isDuplicateMutation(error)) {
        return this.reloadCart(this.prisma, cart.id);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------- summary

  /**
   * Résumé conversationnel (validé §24 + D10) : généré SERVEUR depuis un
   * panier revalidé — l'insertion et l'envoi restent des actions explicites.
   */
  async summaryText(
    tenant: TenantContext,
    conversationId: string,
  ): Promise<{
    text: string;
    cartVersion: number;
    isRevalidated: boolean;
    reservationExpiresAt: Date | null;
    warnings: Array<{ cartItemId: string; status: string }>;
  }> {
    const { cart, lines } = await this.revalidate(tenant, conversationId);
    if (cart.items.length === 0) {
      throw new CartEmptyError();
    }
    const deliveryDecided = cart.checkout?.fulfillmentType != null;
    const text = buildCartSummaryText({
      lines: cart.items.map((item) => ({
        productName: item.productNameSnapshot,
        variantName: item.variantNameSnapshot,
        quantity: item.quantity,
        lineSubtotalMinor: item.lineSubtotalMinor,
      })),
      currency: cart.currency,
      subtotalMinor: cart.subtotalMinor,
      deliveryFeeMinor: cart.deliveryFeeMinor,
      totalMinor: cart.totalMinor,
      deliveryDecided,
    });
    return {
      text,
      cartVersion: cart.version,
      isRevalidated: true,
      reservationExpiresAt: earliestReservationExpiry(cart),
      warnings: lines
        .filter((line) => line.status !== 'VALID')
        .map((line) => ({ cartItemId: line.cartItemId, status: line.status })),
    };
  }

  // ------------------------------------------------------------- helpers

  async requireOpenCartId(
    tenant: TenantContext,
    conversationId: string,
  ): Promise<{ id: string }> {
    const cart = await this.prisma.cart.findFirst({
      where: {
        conversationId,
        organizationId: tenant.organizationId,
        status: { in: [...OPEN_STATUSES] },
      },
      select: { id: true },
    });
    if (!cart) {
      throw new CartNotFoundError();
    }
    return cart;
  }

  async listReservations(tenant: TenantContext, conversationId: string) {
    await this.resolveConversation(tenant, conversationId, { writable: false });
    const cart = await this.requireOpenCartId(tenant, conversationId);
    return this.prisma.stockReservation.findMany({
      where: { cartId: cart.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        cartItemId: true,
        variantId: true,
        quantity: true,
        status: true,
        expiresAt: true,
        maxExpiresAt: true,
        renewedCount: true,
        releasedAt: true,
        createdAt: true,
      },
    });
  }
}
