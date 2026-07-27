import { Prisma } from '@whauto/database';

/** Ligne : snapshot uniquement — productId/variantId sont des références historiques. */
export const ORDER_ITEM_SELECT = {
  id: true,
  productId: true,
  variantId: true,
  productName: true,
  variantName: true,
  sku: true,
  imageUrl: true,
  optionValuesSnapshot: true,
  productTypeSnapshot: true,
  trackInventorySnapshot: true,
  allowBackorderSnapshot: true,
  quantity: true,
  unitPriceMinor: true,
  compareAtPriceMinor: true,
  lineSubtotalMinor: true,
  currency: true,
  stockConsumedQuantity: true,
  backorderedQuantity: true,
  stockRestoredQuantity: true,
} satisfies Prisma.OrderItemSelect;

export const ORDER_DETAIL_SELECT = {
  id: true,
  organizationId: true,
  shopId: true,
  contactId: true,
  conversationId: true,
  cartId: true,
  checkoutSessionId: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  fulfillmentType: true,
  currency: true,
  subtotalMinor: true,
  discountMinor: true,
  deliveryFeeMinor: true,
  totalMinor: true,
  itemCount: true,
  customerName: true,
  customerPhone: true,
  customerEmail: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  countryCode: true,
  landmark: true,
  deliveryInstructions: true,
  paymentPreference: true,
  customerNote: true,
  cancellationReason: true,
  confirmedAt: true,
  processingAt: true,
  readyAt: true,
  shippedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  items: { select: ORDER_ITEM_SELECT, orderBy: { createdAt: 'asc' as const } },
  contact: { select: { id: true, displayName: true, whatsappPhone: true } },
  shop: { select: { id: true, name: true } },
} satisfies Prisma.OrderSelect;

export type OrderDetail = Prisma.OrderGetPayload<{ select: typeof ORDER_DETAIL_SELECT }>;

/** Liste synthétique (validé §22). */
export const ORDER_LIST_SELECT = {
  id: true,
  orderNumber: true,
  shopId: true,
  conversationId: true,
  status: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  fulfillmentType: true,
  currency: true,
  totalMinor: true,
  itemCount: true,
  customerName: true,
  customerPhone: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  shop: { select: { name: true } },
} satisfies Prisma.OrderSelect;

export type OrderListRow = Prisma.OrderGetPayload<{ select: typeof ORDER_LIST_SELECT }>;

export const ORDER_HISTORY_SELECT = {
  id: true,
  changeType: true,
  previousStatus: true,
  newStatus: true,
  previousPaymentStatus: true,
  newPaymentStatus: true,
  previousFulfillmentStatus: true,
  newFulfillmentStatus: true,
  reason: true,
  source: true,
  actorUserId: true,
  createdAt: true,
  actor: { select: { firstName: true, lastName: true } },
} satisfies Prisma.OrderStatusHistorySelect;

export type OrderHistoryRow = Prisma.OrderStatusHistoryGetPayload<{
  select: typeof ORDER_HISTORY_SELECT;
}>;

export const ORDER_NOTE_SELECT = {
  id: true,
  content: true,
  authorUserId: true,
  createdAt: true,
  author: { select: { firstName: true, lastName: true } },
} satisfies Prisma.OrderNoteSelect;

export type OrderNoteRow = Prisma.OrderNoteGetPayload<{ select: typeof ORDER_NOTE_SELECT }>;
