import { apiRequest } from '@/lib/api/client';
import type { StockStatus } from '@whauto/shared';

export interface InventoryRow {
  variantId: string;
  productId: string;
  productName: string;
  variantName: string | null;
  sku: string;
  currency: string;
  priceMinor: number;
  quantityOnHand: number;
  quantityReserved: number;
  quantityAvailable: number;
  lowStockThreshold: number;
  allowBackorder: boolean;
  trackInventory: boolean;
  version: number;
  stockStatus: StockStatus;
  updatedAt: string;
}

export interface PaginatedInventory {
  items: InventoryRow[];
  total: number;
  page: number;
  limit: number;
}

export interface Movement {
  id: string;
  variantId: string;
  type:
    | 'INITIAL'
    | 'ADJUSTMENT'
    | 'RESTOCK'
    | 'DAMAGE'
    | 'RETURN'
    | 'RESERVATION'
    | 'RELEASE'
    | 'SALE'
    | 'CANCELLATION';
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  reason: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actor: { id: string; firstName: string; lastName: string } | null;
  createdAt: string;
}

export interface PaginatedMovements {
  items: Movement[];
  total: number;
  page: number;
  limit: number;
}

export interface ListInventoryParams {
  page?: number;
  limit?: number;
  search?: string;
  stockStatus?: StockStatus;
  includeArchived?: boolean;
}

/** DTO discriminé : RESTOCK/DAMAGE = quantité positive ; ADJUSTMENT = cible + version. */
export type AdjustInput =
  | { type: 'RESTOCK'; quantity: number; restockReason?: string }
  | { type: 'DAMAGE'; quantity: number; reason: string }
  | { type: 'ADJUSTMENT'; newQuantityOnHand: number; expectedVersion: number; reason: string };

export interface AdjustResponse {
  inventory: InventoryRow;
  movement: {
    type: string;
    quantityDelta: number;
    quantityBefore: number;
    quantityAfter: number;
  };
}

function base(organizationId: string, shopId: string): string {
  return `/organizations/${organizationId}/shops/${shopId}`;
}

export const inventoryApi = {
  list(organizationId: string, shopId: string, params: ListInventoryParams = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.search) query.set('search', params.search);
    if (params.stockStatus) query.set('stockStatus', params.stockStatus);
    if (params.includeArchived) query.set('includeArchived', 'true');
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return apiRequest<PaginatedInventory>(`${base(organizationId, shopId)}/inventory${suffix}`);
  },
  getForVariant(organizationId: string, shopId: string, variantId: string) {
    return apiRequest<InventoryRow>(
      `${base(organizationId, shopId)}/variants/${variantId}/inventory`,
    );
  },
  listMovements(
    organizationId: string,
    shopId: string,
    variantId: string,
    params: { page?: number; limit?: number } = {},
  ) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return apiRequest<PaginatedMovements>(
      `${base(organizationId, shopId)}/variants/${variantId}/inventory/movements${suffix}`,
    );
  },
  adjust(organizationId: string, shopId: string, variantId: string, input: AdjustInput) {
    return apiRequest<AdjustResponse>(
      `${base(organizationId, shopId)}/variants/${variantId}/inventory/adjust`,
      { method: 'POST', body: input },
    );
  },
};

export const inventoryKeys = {
  all: (organizationId: string, shopId: string) =>
    ['organizations', organizationId, 'shops', shopId, 'inventory'] as const,
  list: (organizationId: string, shopId: string, params: ListInventoryParams) =>
    [...inventoryKeys.all(organizationId, shopId), 'list', params] as const,
  movements: (organizationId: string, shopId: string, variantId: string, page: number) =>
    [...inventoryKeys.all(organizationId, shopId), 'movements', variantId, page] as const,
};
