import type { Prisma } from '@whauto/database';

import { CATEGORY_SUMMARY_SELECT } from '../categories/categories.mapper';

/**
 * Select variante COMPLET (usage interne service). costPriceMinor n'atteint
 * les réponses HTTP que via les DTO `includeCost` (rôles avec products.update)
 * — jamais un masquage frontend.
 */
export const VARIANT_FULL_SELECT = {
  id: true,
  organizationId: true,
  shopId: true,
  productId: true,
  name: true,
  sku: true,
  barcode: true,
  status: true,
  priceMinor: true,
  compareAtPriceMinor: true,
  costPriceMinor: true,
  trackInventory: true,
  allowBackorder: true,
  weightGrams: true,
  sortOrder: true,
  isDefault: true,
  combinationKey: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
  inventory: {
    select: {
      quantityOnHand: true,
      quantityReserved: true,
      lowStockThreshold: true,
      version: true,
    },
  },
  optionValues: {
    select: {
      optionId: true,
      optionValueId: true,
      option: { select: { name: true, position: true } },
      optionValue: { select: { value: true, position: true } },
    },
  },
} satisfies Prisma.ProductVariantSelect;

export type VariantFull = Prisma.ProductVariantGetPayload<{ select: typeof VARIANT_FULL_SELECT }>;

export const PRODUCT_OPTION_SELECT = {
  id: true,
  name: true,
  position: true,
  values: {
    select: { id: true, value: true, position: true },
    orderBy: [{ position: 'asc' as const }, { id: 'asc' as const }],
  },
} satisfies Prisma.ProductOptionSelect;

export type ProductOptionFull = Prisma.ProductOptionGetPayload<{
  select: typeof PRODUCT_OPTION_SELECT;
}>;

export const PRODUCT_IMAGE_SELECT = {
  id: true,
  variantId: true,
  url: true,
  altText: true,
  position: true,
  isPrimary: true,
} satisfies Prisma.ProductImageSelect;

export type ProductImageRow = Prisma.ProductImageGetPayload<{
  select: typeof PRODUCT_IMAGE_SELECT;
}>;

export const PRODUCT_DETAIL_SELECT = {
  id: true,
  organizationId: true,
  shopId: true,
  categoryId: true,
  name: true,
  slug: true,
  description: true,
  shortDescription: true,
  status: true,
  productType: true,
  currency: true,
  featured: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
  category: { select: CATEGORY_SUMMARY_SELECT },
  options: {
    select: PRODUCT_OPTION_SELECT,
    orderBy: [{ position: 'asc' as const }, { id: 'asc' as const }],
  },
  variants: {
    select: VARIANT_FULL_SELECT,
    orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }],
  },
  images: {
    select: PRODUCT_IMAGE_SELECT,
    orderBy: [{ position: 'asc' as const }, { id: 'asc' as const }],
  },
} satisfies Prisma.ProductSelect;

export type ProductDetail = Prisma.ProductGetPayload<{ select: typeof PRODUCT_DETAIL_SELECT }>;

/** Agrégats calculés par la requête SQL de liste (jamais stockés). */
export interface ProductListAggregates {
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
  variantCount: number;
  totalAvailable: number | null;
  stockStatus: string;
}
