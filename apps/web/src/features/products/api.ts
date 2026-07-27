import { apiRequest } from '@/lib/api/client';
import type { StockStatus } from '@whauto/shared';

export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export type ProductType = 'PHYSICAL' | 'SERVICE' | 'DIGITAL';
export type VariantStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export type { StockStatus };

export interface CategorySummary {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
}

export interface ProductOptionValue {
  id: string;
  value: string;
  position: number;
}

export interface ProductOption {
  id: string;
  name: string;
  position: number;
  values: ProductOptionValue[];
}

export interface ProductImage {
  id: string;
  variantId: string | null;
  url: string;
  altText: string | null;
  position: number;
  isPrimary: boolean;
}

export interface VariantInventory {
  quantityOnHand: number;
  quantityReserved: number;
  quantityAvailable: number;
  lowStockThreshold: number;
  version: number;
}

export interface Variant {
  id: string;
  productId: string;
  name: string | null;
  sku: string;
  barcode: string | null;
  status: VariantStatus;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  /** Présent uniquement pour les rôles disposant de products.update. */
  costPriceMinor?: number | null;
  trackInventory: boolean;
  allowBackorder: boolean;
  weightGrams: number | null;
  sortOrder: number;
  isDefault: boolean;
  optionSelections: Array<{
    optionId: string;
    optionName: string;
    optionValueId: string;
    value: string;
  }>;
  inventory: VariantInventory | null;
  stockStatus: StockStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProductDetail {
  id: string;
  organizationId: string;
  shopId: string;
  categoryId: string | null;
  name: string;
  slug: string;
  description: string | null;
  shortDescription: string | null;
  status: ProductStatus;
  productType: ProductType;
  currency: string;
  featured: boolean;
  category: CategorySummary | null;
  options: ProductOption[];
  variants: Variant[];
  images: ProductImage[];
  stockStatus: StockStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProductListItem {
  id: string;
  name: string;
  slug: string;
  status: ProductStatus;
  productType: ProductType;
  currency: string;
  featured: boolean;
  category: CategorySummary | null;
  primaryImageUrl: string | null;
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
  variantCount: number;
  totalAvailable: number | null;
  stockStatus: StockStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedProducts {
  items: ProductListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface ListProductsParams {
  page?: number;
  limit?: number;
  search?: string;
  categoryId?: string;
  status?: ProductStatus;
  featured?: boolean;
  stockStatus?: StockStatus;
  includeArchived?: boolean;
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'price';
  sortDir?: 'asc' | 'desc';
}

export interface CreateVariantInput {
  name?: string;
  sku: string;
  barcode?: string;
  priceMinor: number;
  compareAtPriceMinor?: number;
  costPriceMinor?: number;
  trackInventory?: boolean;
  allowBackorder?: boolean;
  weightGrams?: number;
  sortOrder?: number;
  isDefault?: boolean;
  optionSelections?: Array<{ optionName: string; value: string }>;
  initialQuantity?: number;
  lowStockThreshold?: number;
}

export interface CreateProductInput {
  name: string;
  slug?: string;
  description?: string;
  shortDescription?: string;
  categoryId?: string;
  productType?: ProductType;
  featured?: boolean;
  options?: Array<{ name: string; values: string[] }>;
  variants: CreateVariantInput[];
  images?: Array<{ url: string; altText?: string; isPrimary?: boolean }>;
}

export type UpdateProductInput = Partial<{
  name: string;
  slug: string;
  description: string | null;
  shortDescription: string | null;
  categoryId: string | null;
  featured: boolean;
}>;

export type UpdateVariantInput = Partial<{
  name: string | null;
  sku: string;
  barcode: string | null;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  costPriceMinor: number | null;
  trackInventory: boolean;
  allowBackorder: boolean;
  weightGrams: number | null;
  sortOrder: number;
  isDefault: boolean;
}>;

function base(organizationId: string, shopId: string): string {
  return `/organizations/${organizationId}/shops/${shopId}/products`;
}

export const productsApi = {
  list(organizationId: string, shopId: string, params: ListProductsParams = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.search) query.set('search', params.search);
    if (params.categoryId) query.set('categoryId', params.categoryId);
    if (params.status) query.set('status', params.status);
    if (params.featured) query.set('featured', 'true');
    if (params.stockStatus) query.set('stockStatus', params.stockStatus);
    if (params.includeArchived) query.set('includeArchived', 'true');
    if (params.sortBy) query.set('sortBy', params.sortBy);
    if (params.sortDir) query.set('sortDir', params.sortDir);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return apiRequest<PaginatedProducts>(`${base(organizationId, shopId)}${suffix}`);
  },
  get(organizationId: string, shopId: string, productId: string) {
    return apiRequest<ProductDetail>(`${base(organizationId, shopId)}/${productId}`);
  },
  create(organizationId: string, shopId: string, input: CreateProductInput) {
    return apiRequest<ProductDetail>(base(organizationId, shopId), { method: 'POST', body: input });
  },
  update(organizationId: string, shopId: string, productId: string, input: UpdateProductInput) {
    return apiRequest<ProductDetail>(`${base(organizationId, shopId)}/${productId}`, {
      method: 'PATCH',
      body: input,
    });
  },
  activate(organizationId: string, shopId: string, productId: string) {
    return apiRequest<ProductDetail>(`${base(organizationId, shopId)}/${productId}/activate`, {
      method: 'POST',
    });
  },
  deactivate(organizationId: string, shopId: string, productId: string) {
    return apiRequest<ProductDetail>(`${base(organizationId, shopId)}/${productId}/deactivate`, {
      method: 'POST',
    });
  },
  archive(organizationId: string, shopId: string, productId: string) {
    return apiRequest<ProductDetail>(`${base(organizationId, shopId)}/${productId}/archive`, {
      method: 'POST',
    });
  },
  replaceImages(
    organizationId: string,
    shopId: string,
    productId: string,
    images: Array<{ url: string; altText?: string; isPrimary?: boolean }>,
  ) {
    return apiRequest<ProductDetail>(`${base(organizationId, shopId)}/${productId}/images`, {
      method: 'PUT',
      body: { images },
    });
  },
  createVariant(organizationId: string, shopId: string, productId: string, input: CreateVariantInput) {
    return apiRequest<Variant>(`${base(organizationId, shopId)}/${productId}/variants`, {
      method: 'POST',
      body: input,
    });
  },
  updateVariant(
    organizationId: string,
    shopId: string,
    productId: string,
    variantId: string,
    input: UpdateVariantInput,
  ) {
    return apiRequest<Variant>(`${base(organizationId, shopId)}/${productId}/variants/${variantId}`, {
      method: 'PATCH',
      body: input,
    });
  },
  variantAction(
    organizationId: string,
    shopId: string,
    productId: string,
    variantId: string,
    action: 'activate' | 'deactivate' | 'archive',
  ) {
    return apiRequest<Variant>(
      `${base(organizationId, shopId)}/${productId}/variants/${variantId}/${action}`,
      { method: 'POST' },
    );
  },
  /**
   * Revalidation FRAÎCHE d'une variante (sélecteur inbox) : statuts, prix,
   * stock relus en base — jamais le cache du catalogue.
   */
  lookupVariant(organizationId: string, shopId: string, variantId: string) {
    return apiRequest<{ product: ProductDetail; variant: Variant }>(
      `/organizations/${organizationId}/shops/${shopId}/variants/${variantId}`,
    );
  },
};

export const productKeys = {
  all: (organizationId: string, shopId: string) =>
    ['organizations', organizationId, 'shops', shopId, 'products'] as const,
  list: (organizationId: string, shopId: string, params: ListProductsParams) =>
    [...productKeys.all(organizationId, shopId), 'list', params] as const,
  detail: (organizationId: string, shopId: string, productId: string) =>
    [...productKeys.all(organizationId, shopId), 'detail', productId] as const,
};
