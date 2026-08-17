import { Prisma } from '@whauto/database';
import {
  CartConcurrencyError,
  CartNotActiveError,
  CheckoutAlreadyConfirmedError,
  computeCartTotals,
  ValidationError,
} from '@whauto/shared';

/**
 * Cœur de mutation panier — SOURCE UNIQUE partagée entre l'API (`CartsService`)
 * et le worker (outils IA WRITE). Fonctions PURES au sens framework : elles
 * opèrent sur un `Prisma.TransactionClient` fourni par l'appelant (qui possède la
 * frontière transactionnelle, le contexte tenant et l'audit). Aucun `process.env`,
 * aucun état. Les invariants (verrou, idempotence, versions, totaux) sont
 * garantis ICI — plus jamais dupliqués.
 *
 * Slice 1 (W0) : helpers déterministes sans dépendance sur les réservations ni
 * l'audit. Les corps de mutation (add/update/remove) suivront avec réservation +
 * audit INJECTÉS.
 */

export const CART_OPEN_STATUSES = ['ACTIVE', 'CHECKOUT_STARTED'] as const;
export type CartOpenStatus = (typeof CART_OPEN_STATUSES)[number];

/** Verrou pessimiste : sérialise TOUTES les mutations d'un même panier. */
export async function lockCartRow(tx: Prisma.TransactionClient, cartId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "carts" WHERE "id" = ${cartId} FOR UPDATE`;
}

/**
 * Idempotence ciblée : l'insertion dans la MÊME transaction déduplique — un P2002
 * sur (conversationId, clientMutationId) signifie « déjà appliqué », l'appelant
 * renvoie l'état courant sans double effet. No-op si aucun clientMutationId.
 */
export async function claimCartMutation(
  tx: Prisma.TransactionClient,
  params: { organizationId: string; conversationId: string; clientMutationId: string | undefined },
): Promise<void> {
  if (params.clientMutationId === undefined) {
    return;
  }
  await tx.cartMutation.create({
    data: {
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      clientMutationId: params.clientMutationId,
    },
    select: { id: true },
  });
}

/** Vrai si l'erreur est le P2002 d'un clientMutationId déjà consommé (rejeu réseau). */
export function isDuplicateCartMutation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  return Array.isArray(target) && target.includes('clientMutationId');
}

/** Refuse toute mutation d'un panier confirmé ou hors statuts ouverts. */
export function assertCartMutable(cart: {
  status: string;
  checkout: { status: string } | null;
}): void {
  if (cart.checkout?.status === 'CONFIRMED') {
    throw new CheckoutAlreadyConfirmedError();
  }
  if (!CART_OPEN_STATUSES.includes(cart.status as CartOpenStatus)) {
    throw new CartNotActiveError(cart.status);
  }
}

/** Verrou optimiste : la version attendue doit correspondre à l'actuelle. */
export function assertCartVersion(cart: { version: number }, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && expectedVersion !== cart.version) {
    throw new CartConcurrencyError();
  }
}

/** Recalcule totaux + compteurs et incrémente la version — DANS la transaction. */
export async function recalcAndTouchCart(
  tx: Prisma.TransactionClient,
  cartId: string,
  inactivityTtlMinutes: number,
): Promise<void> {
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
      expiresAt: new Date(Date.now() + inactivityTtlMinutes * 60_000),
    },
    select: { id: true },
  });
}
