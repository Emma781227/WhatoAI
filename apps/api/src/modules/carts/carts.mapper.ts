import type { Prisma } from '@whauto/database';

/** Résumé de réservation exposé à TOUS les rôles via la réponse Cart (validé). */
export const RESERVATION_SUMMARY_SELECT = {
  id: true,
  cartItemId: true,
  quantity: true,
  status: true,
  expiresAt: true,
  maxExpiresAt: true,
} satisfies Prisma.StockReservationSelect;

export const CART_ITEM_SELECT = {
  id: true,
  cartId: true,
  productId: true,
  variantId: true,
  quantity: true,
  unitPriceMinor: true,
  compareAtPriceMinor: true,
  lineSubtotalMinor: true,
  productNameSnapshot: true,
  variantNameSnapshot: true,
  skuSnapshot: true,
  imageUrlSnapshot: true,
  optionValuesSnapshot: true,
  availabilityStatus: true,
  currentPriceMinor: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  reservations: {
    select: RESERVATION_SUMMARY_SELECT,
    where: { status: 'ACTIVE' as const },
  },
} satisfies Prisma.CartItemSelect;

export const CHECKOUT_SELECT = {
  id: true,
  cartId: true,
  status: true,
  customerName: true,
  customerPhone: true,
  customerEmail: true,
  fulfillmentType: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  countryCode: true,
  landmark: true,
  deliveryInstructions: true,
  paymentPreference: true,
  confirmationSnapshot: true,
  version: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CheckoutSessionSelect;

export const CART_DETAIL_SELECT = {
  id: true,
  organizationId: true,
  shopId: true,
  contactId: true,
  conversationId: true,
  status: true,
  currency: true,
  subtotalMinor: true,
  discountMinor: true,
  deliveryFeeMinor: true,
  totalMinor: true,
  itemCount: true,
  version: true,
  lastActivityAt: true,
  expiresAt: true,
  checkoutStartedAt: true,
  createdAt: true,
  updatedAt: true,
  items: {
    select: CART_ITEM_SELECT,
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  },
  checkout: { select: CHECKOUT_SELECT },
} satisfies Prisma.CartSelect;

export type CartDetail = Prisma.CartGetPayload<{ select: typeof CART_DETAIL_SELECT }>;
export type CartItemRow = Prisma.CartItemGetPayload<{ select: typeof CART_ITEM_SELECT }>;
export type CheckoutRow = Prisma.CheckoutSessionGetPayload<{ select: typeof CHECKOUT_SELECT }>;

/** Plus proche expiration parmi les réservations ACTIVE du panier. */
export function earliestReservationExpiry(cart: CartDetail): Date | null {
  const expiries = cart.items
    .flatMap((item) => item.reservations)
    .map((reservation) => reservation.expiresAt.getTime());
  return expiries.length > 0 ? new Date(Math.min(...expiries)) : null;
}
