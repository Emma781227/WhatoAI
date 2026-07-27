import { apiRequest } from '@/lib/api/client';

export type CartStatus = 'ACTIVE' | 'CHECKOUT_STARTED' | 'CONVERTED' | 'ABANDONED' | 'EXPIRED';
export type CheckoutStatus =
  | 'COLLECTING_INFORMATION'
  | 'READY_FOR_CONFIRMATION'
  | 'CONFIRMED'
  | 'CANCELLED'
  | 'EXPIRED';
export type FulfillmentType = 'DELIVERY' | 'PICKUP';
export type PaymentPreference =
  | 'CASH_ON_DELIVERY'
  | 'MOBILE_MONEY'
  | 'CARD'
  | 'PAY_IN_STORE'
  | 'UNDECIDED';
export type CartLineAvailability =
  | 'VALID'
  | 'PRICE_CHANGED'
  | 'OUT_OF_STOCK'
  | 'QUANTITY_REDUCED_REQUIRED'
  | 'PRODUCT_UNAVAILABLE'
  | 'VARIANT_UNAVAILABLE';

export interface CartItem {
  id: string;
  productId: string;
  variantId: string;
  quantity: number;
  unitPriceMinor: number;
  compareAtPriceMinor: number | null;
  lineSubtotalMinor: number;
  productName: string;
  variantName: string | null;
  sku: string;
  imageUrl: string | null;
  optionValues: Array<[string, string]> | null;
  availabilityStatus: CartLineAvailability;
  currentPriceMinor: number | null;
  version: number;
  reservation: {
    id: string;
    quantity: number;
    status: string;
    expiresAt: string;
  } | null;
}

export interface Checkout {
  id: string;
  status: CheckoutStatus;
  customerName: string | null;
  customerPhone: string;
  customerEmail: string | null;
  fulfillmentType: FulfillmentType | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  landmark: string | null;
  deliveryInstructions: string | null;
  paymentPreference: PaymentPreference;
  confirmationSnapshot: unknown;
  version: number;
  completedAt: string | null;
}

export interface Cart {
  id: string;
  organizationId: string;
  shopId: string;
  contactId: string;
  conversationId: string;
  status: CartStatus;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  itemCount: number;
  version: number;
  items: CartItem[];
  checkout: Checkout | null;
  reservationExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CartSummary {
  text: string;
  cartVersion: number;
  isRevalidated: boolean;
  reservationExpiresAt: string | null;
  warnings: Array<{ cartItemId: string; status: string }>;
}

export interface UpdateCheckoutInput {
  expectedVersion: number;
  customerName?: string | null;
  customerPhone?: string;
  customerEmail?: string | null;
  fulfillmentType?: FulfillmentType;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  landmark?: string | null;
  deliveryInstructions?: string | null;
  paymentPreference?: PaymentPreference;
}

function base(organizationId: string, conversationId: string): string {
  return `/organizations/${organizationId}/conversations/${conversationId}/cart`;
}

export const cartsApi = {
  /** 404 = aucun panier ouvert (état vide côté UI, pas une erreur). */
  get(organizationId: string, conversationId: string) {
    return apiRequest<Cart>(base(organizationId, conversationId));
  },
  addItem(
    organizationId: string,
    conversationId: string,
    input: { variantId: string; quantity: number; expectedVersion?: number; clientMutationId?: string },
  ) {
    return apiRequest<Cart>(`${base(organizationId, conversationId)}/items`, {
      method: 'POST',
      body: input,
    });
  },
  updateItem(
    organizationId: string,
    conversationId: string,
    cartItemId: string,
    input: { quantity: number; expectedVersion: number; clientMutationId?: string },
  ) {
    return apiRequest<Cart>(`${base(organizationId, conversationId)}/items/${cartItemId}`, {
      method: 'PATCH',
      body: input,
    });
  },
  acceptCurrentPrice(
    organizationId: string,
    conversationId: string,
    cartItemId: string,
    input: { expectedVersion?: number },
  ) {
    return apiRequest<Cart>(
      `${base(organizationId, conversationId)}/items/${cartItemId}/accept-current-price`,
      { method: 'POST', body: input },
    );
  },
  removeItem(
    organizationId: string,
    conversationId: string,
    cartItemId: string,
    input: { expectedVersion?: number },
  ) {
    return apiRequest<Cart>(`${base(organizationId, conversationId)}/items/${cartItemId}`, {
      method: 'DELETE',
      body: input,
    });
  },
  clear(organizationId: string, conversationId: string, input: { expectedVersion?: number }) {
    return apiRequest<Cart>(`${base(organizationId, conversationId)}/clear`, {
      method: 'POST',
      body: input,
    });
  },
  revalidate(organizationId: string, conversationId: string) {
    return apiRequest<{ cart: Cart; lines: Array<{ cartItemId: string; status: string; maxQuantity?: number }> }>(
      `${base(organizationId, conversationId)}/revalidate`,
      { method: 'POST', body: {} },
    );
  },
  abandon(organizationId: string, conversationId: string, input: { clientMutationId?: string }) {
    return apiRequest<Cart>(`${base(organizationId, conversationId)}/abandon`, {
      method: 'POST',
      body: input,
    });
  },
  summaryText(organizationId: string, conversationId: string) {
    return apiRequest<CartSummary>(`${base(organizationId, conversationId)}/summary-text`);
  },
  startCheckout(
    organizationId: string,
    conversationId: string,
    input: { expectedVersion?: number; clientMutationId?: string },
  ) {
    return apiRequest<Cart>(`${base(organizationId, conversationId)}/checkout/start`, {
      method: 'POST',
      body: input,
    });
  },
  updateCheckout(organizationId: string, conversationId: string, input: UpdateCheckoutInput) {
    return apiRequest<Cart>(`${base(organizationId, conversationId)}/checkout`, {
      method: 'PATCH',
      body: input,
    });
  },
  confirmCheckout(
    organizationId: string,
    conversationId: string,
    input: { expectedVersion: number; clientMutationId?: string },
  ) {
    return apiRequest<Cart>(`${base(organizationId, conversationId)}/checkout/confirm`, {
      method: 'POST',
      body: input,
    });
  },
  cancelCheckout(organizationId: string, conversationId: string) {
    return apiRequest<Cart>(`${base(organizationId, conversationId)}/checkout/cancel`, {
      method: 'POST',
    });
  },
};

/** Query keys scoppées organizationId + conversationId : zéro fuite. */
export const cartKeys = {
  all: (organizationId: string) => ['organizations', organizationId, 'carts'] as const,
  detail: (organizationId: string, conversationId: string) =>
    [...cartKeys.all(organizationId), conversationId] as const,
};
