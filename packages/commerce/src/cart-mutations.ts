import { Prisma } from '@whauto/database';
import {
  CartInsufficientStockError,
  CartItemNotFoundError,
  computeLineSubtotal,
  ValidationError,
} from '@whauto/shared';

import {
  assertCartMutable,
  assertCartVersion,
  claimCartMutation,
  lockCartRow,
  recalcAndTouchCart,
} from './cart-core';

/**
 * Corps de mutation panier — SOURCE UNIQUE partagée API/worker (W0 slice 2).
 * Chaque fonction opère DANS une transaction fournie par l'appelant et suit le
 * même préambule verrouillé (lock → claim idempotent → assert mutable/version).
 * Les réservations et l'audit sont INJECTÉS en closures (`CartMutationDeps`) :
 * le cœur ne connaît ni `ReservationConfig` ni le service d'audit — l'appelant
 * capture org/shop/config/acteur. La branche réservation ne se déclenche qu'en
 * `CHECKOUT_STARTED`. L'appelant recharge le panier et émet le temps réel APRÈS.
 */

const MAX_QUANTITY_PER_LINE = 999;

export interface CartVariantForAdd {
  id: string;
  productId: string;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  trackInventory: boolean;
  allowBackorder: boolean;
  name: string | null;
  sku: string;
  product: { name: string; images: Array<{ url: string }> };
  optionValues: Array<{ option: { name: string; position: number }; optionValue: { value: string } }>;
  inventory: { quantityOnHand: number; quantityReserved: number } | null;
}

/** Référence de réservation (ajustement de delta — pas besoin de la quantité). */
export interface CartReservationRef {
  id: string;
  variantId: string;
  organizationId: string;
  shopId: string;
}

/** Réservation avec quantité (release complet à la suppression de ligne). */
export interface CartReservationWithQuantity extends CartReservationRef {
  quantity: number;
}

/** Dépendances injectées : réservations + audit (closures capturant le scope). */
export interface CartMutationDeps {
  reserveForItem(
    tx: Prisma.TransactionClient,
    params: { cartItemId: string; variantId: string; quantity: number; trackInventory: boolean },
  ): Promise<void>;
  adjustActiveReservation(
    tx: Prisma.TransactionClient,
    reservation: CartReservationRef,
    delta: number,
  ): Promise<void>;
  releaseReservation(
    tx: Prisma.TransactionClient,
    reservation: CartReservationWithQuantity,
    reason: string,
  ): Promise<void>;
  recordAudit(
    tx: Prisma.TransactionClient,
    event: { eventType: string; metadata: Record<string, unknown> },
  ): Promise<void>;
}

interface MutationScope {
  organizationId: string;
  shopId: string;
  conversationId: string;
  cartId: string;
  inactivityTtlMinutes: number;
}

/** Préambule commun : verrou + idempotence + assertions. Renvoie l'état courant. */
async function beginCartMutation(
  tx: Prisma.TransactionClient,
  scope: MutationScope,
  opts: { expectedVersion?: number; clientMutationId?: string },
): Promise<{ status: string }> {
  await lockCartRow(tx, scope.cartId);
  await claimCartMutation(tx, {
    organizationId: scope.organizationId,
    conversationId: scope.conversationId,
    clientMutationId: opts.clientMutationId,
  });
  const current = await tx.cart.findUniqueOrThrow({
    where: { id: scope.cartId },
    select: { status: true, version: true, checkout: { select: { status: true } } },
  });
  assertCartMutable(current);
  assertCartVersion(current, opts.expectedVersion);
  return { status: current.status };
}

/** Ajoute (ou incrémente) une ligne. Le variant est revalidé FRAIS par l'appelant. */
export async function addItemToCartTx(
  tx: Prisma.TransactionClient,
  params: MutationScope & {
    variant: CartVariantForAdd;
    quantity: number;
    expectedVersion?: number;
    clientMutationId?: string;
  },
  deps: CartMutationDeps,
): Promise<{ cartItemId: string }> {
  const { variant } = params;
  const current = await beginCartMutation(tx, params, {
    expectedVersion: params.expectedVersion,
    clientMutationId: params.clientMutationId,
  });

  const existingItem = await tx.cartItem.findUnique({
    where: { cartId_variantId: { cartId: params.cartId, variantId: variant.id } },
    select: {
      id: true,
      quantity: true,
      unitPriceMinor: true,
      reservations: {
        where: { status: 'ACTIVE' },
        select: { id: true, variantId: true, organizationId: true, shopId: true },
      },
    },
  });
  const newQuantity = (existingItem?.quantity ?? 0) + params.quantity;
  if (newQuantity > MAX_QUANTITY_PER_LINE) {
    throw new ValidationError('Maximum quantity per line is 999.');
  }

  // Disponibilité à l'ajout : le stock DISPONIBLE couvre la quantité totale
  // (hors backorder). Les réservations de CE panier pour cette ligne ne comptent
  // pas comme "pris".
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
        lineSubtotalMinor: computeLineSubtotal(existingItem.unitPriceMinor, newQuantity),
        version: { increment: 1 },
      },
      select: { id: true },
    });
    if (current.status === 'CHECKOUT_STARTED' && existingItem.reservations[0]) {
      await deps.adjustActiveReservation(tx, existingItem.reservations[0], params.quantity);
    }
  } else {
    const optionValues = variant.optionValues
      .slice()
      .sort((a, b) => a.option.position - b.option.position)
      .map((link) => [link.option.name, link.optionValue.value]);
    const created = await tx.cartItem.create({
      data: {
        organizationId: params.organizationId,
        shopId: params.shopId,
        cartId: params.cartId,
        productId: variant.productId,
        variantId: variant.id,
        quantity: params.quantity,
        unitPriceMinor: variant.priceMinor,
        compareAtPriceMinor: variant.compareAtPriceMinor,
        lineSubtotalMinor: computeLineSubtotal(variant.priceMinor, params.quantity),
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
      await deps.reserveForItem(tx, {
        cartItemId: created.id,
        variantId: variant.id,
        quantity: params.quantity,
        trackInventory: variant.trackInventory,
      });
    }
  }

  await recalcAndTouchCart(tx, params.cartId, params.inactivityTtlMinutes);
  await deps.recordAudit(tx, {
    eventType: 'CART_ITEM_ADDED',
    metadata: { cartId: params.cartId, cartItemId: itemId, variantId: variant.id, quantity: params.quantity },
  });
  return { cartItemId: itemId };
}

/** Fixe la quantité d'une ligne (delta réservé/libéré si panier en checkout). */
export async function updateCartItemQuantityTx(
  tx: Prisma.TransactionClient,
  params: MutationScope & {
    cartItemId: string;
    quantity: number;
    expectedVersion?: number;
    clientMutationId?: string;
  },
  deps: CartMutationDeps,
): Promise<void> {
  const current = await beginCartMutation(tx, params, {
    expectedVersion: params.expectedVersion,
    clientMutationId: params.clientMutationId,
  });

  const item = await tx.cartItem.findFirst({
    where: { id: params.cartItemId, cartId: params.cartId },
    select: {
      id: true,
      quantity: true,
      unitPriceMinor: true,
      reservations: {
        where: { status: 'ACTIVE' },
        select: { id: true, variantId: true, organizationId: true, shopId: true },
      },
    },
  });
  if (!item) {
    throw new CartItemNotFoundError();
  }
  const delta = params.quantity - item.quantity;
  if (delta === 0) {
    throw new ValidationError('The quantity is unchanged.');
  }

  await tx.cartItem.update({
    where: { id: item.id },
    data: {
      quantity: params.quantity,
      lineSubtotalMinor: computeLineSubtotal(item.unitPriceMinor, params.quantity),
      version: { increment: 1 },
    },
    select: { id: true },
  });

  if (current.status === 'CHECKOUT_STARTED' && item.reservations[0]) {
    await deps.adjustActiveReservation(tx, item.reservations[0], delta);
  }

  await recalcAndTouchCart(tx, params.cartId, params.inactivityTtlMinutes);
  await deps.recordAudit(tx, {
    eventType: 'CART_ITEM_UPDATED',
    metadata: { cartId: params.cartId, cartItemId: params.cartItemId, quantity: params.quantity, delta },
  });
}

/** Supprime une ligne (release complet des réservations avant suppression). */
export async function removeCartItemTx(
  tx: Prisma.TransactionClient,
  params: MutationScope & { cartItemId: string; expectedVersion?: number },
  deps: CartMutationDeps,
): Promise<void> {
  await beginCartMutation(tx, params, { expectedVersion: params.expectedVersion });

  const item = await tx.cartItem.findFirst({
    where: { id: params.cartItemId, cartId: params.cartId },
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

  for (const reservation of item.reservations) {
    await deps.releaseReservation(tx, reservation, 'item removed');
  }
  await tx.cartItem.delete({ where: { id: item.id }, select: { id: true } });

  await recalcAndTouchCart(tx, params.cartId, params.inactivityTtlMinutes);
  await deps.recordAudit(tx, {
    eventType: 'CART_ITEM_REMOVED',
    metadata: { cartId: params.cartId, cartItemId: params.cartItemId },
  });
}
