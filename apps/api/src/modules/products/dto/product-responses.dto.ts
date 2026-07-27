import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ProductCategoryStatus,
  ProductStatus,
  ProductType,
  ProductVariantStatus,
} from '@whauto/database';
import {
  aggregateProductStockStatus,
  computeQuantityAvailable,
  computeVariantStockStatus,
} from '@whauto/shared';
import type { StockStatus } from '@whauto/shared';

import type {
  ProductDetail,
  ProductImageRow,
  ProductListAggregates,
  ProductOptionFull,
  VariantFull,
} from '../products.mapper';

export class CategorySummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  /** ARCHIVED = le produit reste lié pour l'historique, l'UI l'affiche clairement. */
  @ApiProperty({ enum: ProductCategoryStatus })
  status!: ProductCategoryStatus;
}

export class ProductOptionValueDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  value!: string;

  @ApiProperty()
  position!: number;
}

export class ProductOptionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  position!: number;

  @ApiProperty({ type: [ProductOptionValueDto] })
  values!: ProductOptionValueDto[];
}

export class ProductImageDto {
  @ApiProperty()
  id!: string;

  @ApiPropertyOptional({ nullable: true })
  variantId!: string | null;

  @ApiProperty()
  url!: string;

  @ApiPropertyOptional({ nullable: true })
  altText!: string | null;

  @ApiProperty()
  position!: number;

  @ApiProperty()
  isPrimary!: boolean;
}

export class VariantOptionSelectionResponseDto {
  @ApiProperty()
  optionId!: string;

  @ApiProperty()
  optionName!: string;

  @ApiProperty()
  optionValueId!: string;

  @ApiProperty()
  value!: string;
}

export class VariantInventoryDto {
  @ApiProperty()
  quantityOnHand!: number;

  @ApiProperty()
  quantityReserved!: number;

  @ApiProperty({ description: 'onHand − reserved ; peut être négatif (backorder).' })
  quantityAvailable!: number;

  @ApiProperty()
  lowStockThreshold!: number;

  @ApiProperty({ description: 'Verrou optimiste pour les ADJUSTMENT.' })
  version!: number;
}

export class VariantResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  productId!: string;

  @ApiPropertyOptional({ nullable: true })
  name!: string | null;

  @ApiProperty()
  sku!: string;

  @ApiPropertyOptional({ nullable: true })
  barcode!: string | null;

  @ApiProperty({ enum: ProductVariantStatus })
  status!: ProductVariantStatus;

  @ApiProperty()
  priceMinor!: number;

  @ApiPropertyOptional({ nullable: true })
  compareAtPriceMinor!: number | null;

  /** Présent uniquement pour les rôles disposant de products.update. */
  @ApiPropertyOptional({ nullable: true })
  costPriceMinor?: number | null;

  @ApiProperty()
  trackInventory!: boolean;

  @ApiProperty()
  allowBackorder!: boolean;

  @ApiPropertyOptional({ nullable: true })
  weightGrams!: number | null;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isDefault!: boolean;

  @ApiProperty({ type: [VariantOptionSelectionResponseDto] })
  optionSelections!: VariantOptionSelectionResponseDto[];

  @ApiPropertyOptional({ type: VariantInventoryDto, nullable: true })
  inventory!: VariantInventoryDto | null;

  @ApiProperty({ enum: ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'NOT_TRACKED', 'BACKORDERED'] })
  stockStatus!: StockStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  archivedAt!: Date | null;

  /**
   * includeCost = permission products.update vérifiée côté contrôleur — le
   * champ est RETIRÉ du payload pour l'AGENT, pas masqué côté client.
   */
  static fromVariant(variant: VariantFull, options: { includeCost: boolean }): VariantResponseDto {
    // combinationKey reste interne (représentation technique, pas un contrat API).
    const { optionValues, inventory, combinationKey, costPriceMinor, ...rest } = variant;
    void combinationKey;
    const stockStatus = computeVariantStockStatus({
      trackInventory: variant.trackInventory,
      allowBackorder: variant.allowBackorder,
      quantityOnHand: inventory?.quantityOnHand ?? 0,
      quantityReserved: inventory?.quantityReserved ?? 0,
      lowStockThreshold: inventory?.lowStockThreshold ?? 0,
    });
    const dto = Object.assign(new VariantResponseDto(), rest, {
      optionSelections: optionValues
        .slice()
        .sort((a, b) => a.option.position - b.option.position)
        .map((link) => ({
          optionId: link.optionId,
          optionName: link.option.name,
          optionValueId: link.optionValueId,
          value: link.optionValue.value,
        })),
      inventory: inventory
        ? {
            quantityOnHand: inventory.quantityOnHand,
            quantityReserved: inventory.quantityReserved,
            quantityAvailable: computeQuantityAvailable(inventory),
            lowStockThreshold: inventory.lowStockThreshold,
            version: inventory.version,
          }
        : null,
      stockStatus,
    });
    if (options.includeCost) {
      dto.costPriceMinor = costPriceMinor;
    }
    return dto;
  }
}

export class ProductDetailResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  shopId!: string;

  @ApiPropertyOptional({ nullable: true })
  categoryId!: string | null;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiPropertyOptional({ nullable: true })
  shortDescription!: string | null;

  @ApiProperty({ enum: ProductStatus })
  status!: ProductStatus;

  @ApiProperty({ enum: ProductType })
  productType!: ProductType;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  featured!: boolean;

  @ApiPropertyOptional({ type: CategorySummaryDto, nullable: true })
  category!: CategorySummaryDto | null;

  @ApiProperty({ type: [ProductOptionDto] })
  options!: ProductOptionDto[];

  @ApiProperty({ type: [VariantResponseDto] })
  variants!: VariantResponseDto[];

  @ApiProperty({ type: [ProductImageDto] })
  images!: ProductImageDto[];

  @ApiProperty({ enum: ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'NOT_TRACKED', 'BACKORDERED'] })
  stockStatus!: StockStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  archivedAt!: Date | null;

  static fromProduct(
    product: ProductDetail,
    options: { includeCost: boolean },
  ): ProductDetailResponseDto {
    const variants = product.variants.map((variant) =>
      VariantResponseDto.fromVariant(variant, options),
    );
    return Object.assign(new ProductDetailResponseDto(), {
      ...product,
      options: product.options as ProductOptionFull[],
      variants,
      images: product.images as ProductImageRow[],
      stockStatus: aggregateProductStockStatus(
        variants.filter((v) => v.status !== 'ARCHIVED').map((v) => v.stockStatus),
      ),
    });
  }
}

export class ProductListItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ enum: ProductStatus })
  status!: ProductStatus;

  @ApiProperty({ enum: ProductType })
  productType!: ProductType;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  featured!: boolean;

  @ApiPropertyOptional({ type: CategorySummaryDto, nullable: true })
  category!: CategorySummaryDto | null;

  @ApiPropertyOptional({ nullable: true })
  primaryImageUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  minPriceMinor!: number | null;

  @ApiPropertyOptional({ nullable: true })
  maxPriceMinor!: number | null;

  @ApiProperty()
  variantCount!: number;

  @ApiPropertyOptional({ nullable: true })
  totalAvailable!: number | null;

  @ApiProperty({ enum: ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'NOT_TRACKED', 'BACKORDERED'] })
  stockStatus!: StockStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export interface ProductListRow {
  id: string;
  name: string;
  slug: string;
  status: ProductStatus;
  productType: ProductType;
  currency: string;
  featured: boolean;
  createdAt: Date;
  updatedAt: Date;
  category: CategorySummaryDto | null;
  primaryImageUrl: string | null;
  aggregates: ProductListAggregates;
}

export function toProductListItem(row: ProductListRow): ProductListItemDto {
  return Object.assign(new ProductListItemDto(), {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    productType: row.productType,
    currency: row.currency,
    featured: row.featured,
    category: row.category,
    primaryImageUrl: row.primaryImageUrl,
    minPriceMinor: row.aggregates.minPriceMinor,
    maxPriceMinor: row.aggregates.maxPriceMinor,
    variantCount: row.aggregates.variantCount,
    totalAvailable: row.aggregates.totalAvailable,
    stockStatus: row.aggregates.stockStatus as StockStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
