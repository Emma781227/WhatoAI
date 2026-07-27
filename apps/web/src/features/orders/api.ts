import { apiRequest } from '@/lib/api/client';

import type { FulfillmentType, PaymentPreference } from '@/features/carts/api';

export type OrderStatus =
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'READY'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED';
export type OrderPaymentStatus =
  | 'UNPAID'
  | 'PENDING'
  | 'PAID'
  | 'FAILED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED';
export type OrderFulfillmentStatus =
  | 'PENDING'
  | 'PREPARING'
  | 'READY_FOR_PICKUP'
  | 'READY_FOR_SHIPMENT'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'NOT_REQUIRED';

export interface OrderItem {
  id: string;
  productId: string | null;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  sku: string;
  imageUrl: string | null;
  optionValuesSnapshot: Array<[string, string]> | null;
  productTypeSnapshot: string;
  trackInventorySnapshot: boolean;
  quantity: number;
  unitPriceMinor: number;
  compareAtPriceMinor: number | null;
  lineSubtotalMinor: number;
  currency: string;
  stockConsumedQuantity: number;
  backorderedQuantity: number;
  stockRestoredQuantity: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  shopId: string;
  conversationId: string;
  contactId: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  fulfillmentStatus: OrderFulfillmentStatus;
  fulfillmentType: FulfillmentType;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  itemCount: number;
  customerName: string;
  customerPhone: string;
  customerEmail: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
  landmark: string | null;
  deliveryInstructions: string | null;
  paymentPreference: PaymentPreference;
  cancellationReason: string | null;
  confirmedAt: string;
  processingAt: string | null;
  readyAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
  contact: { id: string; displayName: string | null; whatsappPhone: string };
  shop: { id: string; name: string };
}

export interface OrderListItem {
  id: string;
  orderNumber: string;
  shopId: string;
  conversationId: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  fulfillmentStatus: OrderFulfillmentStatus;
  fulfillmentType: FulfillmentType;
  currency: string;
  totalMinor: number;
  itemCount: number;
  customerName: string;
  customerPhone: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  shopName: string;
}

export interface OrderHistoryEntry {
  id: string;
  changeType: string;
  previousStatus: OrderStatus | null;
  newStatus: OrderStatus;
  previousPaymentStatus: OrderPaymentStatus | null;
  newPaymentStatus: OrderPaymentStatus;
  previousFulfillmentStatus: OrderFulfillmentStatus | null;
  newFulfillmentStatus: OrderFulfillmentStatus;
  reason: string | null;
  source: string;
  actorName: string | null;
  createdAt: string;
}

export interface OrderNote {
  id: string;
  content: string;
  authorName: string | null;
  createdAt: string;
}

export interface OrderListFilters {
  page?: number;
  limit?: number;
  search?: string;
  shopId?: string;
  status?: OrderStatus;
  paymentStatus?: OrderPaymentStatus;
  fulfillmentStatus?: OrderFulfillmentStatus;
  fulfillmentType?: FulfillmentType;
  sortBy?: 'createdAt' | 'updatedAt' | 'totalMinor';
  sortDir?: 'asc' | 'desc';
}

export interface OrderListResponse {
  items: OrderListItem[];
  total: number;
  page: number;
  limit: number;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs === '' ? '' : `?${qs}`;
}

export const ordersApi = {
  convert(
    organizationId: string,
    conversationId: string,
    input: {
      clientMutationId?: string;
      expectedCartVersion?: number;
      expectedCheckoutVersion?: number;
    },
  ) {
    return apiRequest<Order>(
      `/organizations/${organizationId}/conversations/${conversationId}/orders`,
      { method: 'POST', body: input },
    );
  },
  listForConversation(organizationId: string, conversationId: string) {
    return apiRequest<OrderListItem[]>(
      `/organizations/${organizationId}/conversations/${conversationId}/orders`,
    );
  },
  list(organizationId: string, filters: OrderListFilters) {
    return apiRequest<OrderListResponse>(
      `/organizations/${organizationId}/orders${query(filters as Record<string, string | number | undefined>)}`,
    );
  },
  get(organizationId: string, orderId: string) {
    return apiRequest<Order>(`/organizations/${organizationId}/orders/${orderId}`);
  },
  changeStatus(
    organizationId: string,
    orderId: string,
    input: {
      status: OrderStatus;
      expectedVersion: number;
      reason?: string;
      clientMutationId?: string;
    },
  ) {
    return apiRequest<Order>(`/organizations/${organizationId}/orders/${orderId}/status`, {
      method: 'PATCH',
      body: input,
    });
  },
  cancel(
    organizationId: string,
    orderId: string,
    input: { expectedVersion: number; reason?: string; clientMutationId?: string },
  ) {
    return apiRequest<Order>(`/organizations/${organizationId}/orders/${orderId}/cancel`, {
      method: 'POST',
      body: input,
    });
  },
  addNote(
    organizationId: string,
    orderId: string,
    input: { content: string; clientMutationId?: string },
  ) {
    return apiRequest<Order>(`/organizations/${organizationId}/orders/${orderId}/notes`, {
      method: 'POST',
      body: input,
    });
  },
  notes(organizationId: string, orderId: string) {
    return apiRequest<OrderNote[]>(`/organizations/${organizationId}/orders/${orderId}/notes`);
  },
  history(organizationId: string, orderId: string) {
    return apiRequest<OrderHistoryEntry[]>(
      `/organizations/${organizationId}/orders/${orderId}/history`,
    );
  },
  summaryText(organizationId: string, orderId: string) {
    return apiRequest<{ text: string; orderVersion: number; orderNumber: string; warnings: string[] }>(
      `/organizations/${organizationId}/orders/${orderId}/summary-text`,
    );
  },
};

export const orderKeys = {
  all: (organizationId: string) => ['orders', organizationId] as const,
  list: (organizationId: string, filters: OrderListFilters) =>
    ['orders', organizationId, 'list', filters] as const,
  detail: (organizationId: string, orderId: string) =>
    ['orders', organizationId, 'detail', orderId] as const,
  history: (organizationId: string, orderId: string) =>
    ['orders', organizationId, 'history', orderId] as const,
  notes: (organizationId: string, orderId: string) =>
    ['orders', organizationId, 'notes', orderId] as const,
  forConversation: (organizationId: string, conversationId: string) =>
    ['orders', organizationId, 'conversation', conversationId] as const,
};
