import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import {
  buildCombinationKey,
  CategoryArchivedError,
  CategoryNotFoundError,
  DuplicateVariantCombinationError,
  InvalidProductStatusTransitionError,
  InvalidSkuFormatError,
  normalizeBarcode,
  normalizeSku,
  ProductActivationRequirementsError,
  ProductArchivedError,
  ProductNotFoundError,
  ProductSlugAlreadyUsedError,
  ShopArchivedError,
  ShopNotFoundError,
  ValidationError,
  VariantBarcodeAlreadyUsedError,
  VariantSkuAlreadyUsedError,
} from '@whauto/shared';

import { isValidSlug, slugify, suffixedSlug } from '../../common/slug.util';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import type {
  CreateProductDto,
  ListProductsQueryDto,
  ProductImageInputDto,
  UpdateProductDto,
} from './dto/product-inputs.dto';
import { buildProductListQuery, type ProductListSqlRow } from './product-list.query';
import { PRODUCT_DETAIL_SELECT } from './products.mapper';
import type { ProductDetail, ProductListAggregates } from './products.mapper';

const MAX_GENERATED_SLUG_ATTEMPTS = 5;

export function uniqueViolationTarget(error: unknown): string[] | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  const target = error.meta?.target;
  return Array.isArray(target) ? (target as string[]) : [];
}

/**
 * Traduit un P2002 du périmètre variantes en DomainError. Piège documenté :
 * les index partiels SQL bruts remontent leurs COLONNES —
 * (productId, combinationKey) pour la combinaison, (productId) seul pour la
 * variante par défaut.
 */
export function translateVariantUniqueError(error: unknown): never {
  const target = uniqueViolationTarget(error);
  if (target === null) {
    throw error as Error;
  }
  if (target.includes('sku')) {
    throw new VariantSkuAlreadyUsedError();
  }
  if (target.includes('barcode')) {
    throw new VariantBarcodeAlreadyUsedError();
  }
  if (target.includes('combinationKey')) {
    throw new DuplicateVariantCombinationError();
  }
  throw error as Error;
}

export function validateImageUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('Invalid image URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ValidationError('Image URLs must use http(s).');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ValidationError('Image URLs must not contain credentials.');
  }
}

/** Prépare les lignes images : positions déterministes, une seule principale. */
export function prepareImages(images: ProductImageInputDto[]): Array<{
  url: string;
  altText: string | null;
  position: number;
  isPrimary: boolean;
}> {
  const primaryCount = images.filter((image) => image.isPrimary === true).length;
  if (primaryCount > 1) {
    throw new ValidationError('At most one primary image is allowed.');
  }
  return images.map((image, index) => {
    validateImageUrl(image.url);
    return {
      url: image.url,
      altText: image.altText ?? null,
      position: index,
      isPrimary: image.isPrimary === true || (primaryCount === 0 && index === 0),
    };
  });
}

interface PreparedVariant {
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
  combinationKey: string;
  /** Par option : nom normalisé → valeur (libellés bruts). */
  selections: Array<{ optionName: string; value: string }>;
  initialQuantity: number;
  lowStockThreshold: number;
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
  ) {}

  // ------------------------------------------------------------------- create

  async createFull(
    tenant: TenantContext,
    shopId: string,
    input: CreateProductDto,
    context: AuditActionContext,
  ): Promise<ProductDetail> {
    const shop = await this.getWritableShop(tenant, shopId);
    const productType = input.productType ?? 'PHYSICAL';

    if (input.categoryId !== undefined) {
      await this.assertAssignableCategory(tenant, shopId, input.categoryId);
    }

    // -- Options : noms/valeurs trimés, unicité locale.
    const options = (input.options ?? []).map((option, index) => ({
      name: option.name.trim(),
      position: index,
      values: option.values.map((value) => value.trim()),
    }));
    const optionNames = new Set<string>();
    for (const option of options) {
      const key = option.name.toLowerCase();
      if (option.name === '' || optionNames.has(key)) {
        throw new ValidationError(`Duplicate or empty option name: "${option.name}".`);
      }
      optionNames.add(key);
      const valueSet = new Set<string>();
      for (const value of option.values) {
        const valueKey = value.toLowerCase();
        if (value === '' || valueSet.has(valueKey)) {
          throw new ValidationError(`Duplicate or empty value "${value}" for option "${option.name}".`);
        }
        valueSet.add(valueKey);
      }
    }

    const variants = this.prepareVariants(input, options, productType);
    const images = prepareImages(input.images ?? []);

    // -- Slug.
    const slugWasProvided = input.slug !== undefined;
    let slug = slugWasProvided ? input.slug!.trim().toLowerCase() : slugify(input.name);
    if (!isValidSlug(slug)) {
      throw new ValidationError(
        slugWasProvided
          ? 'Slug must be 2-50 characters, lowercase letters, digits and single hyphens.'
          : 'Product name cannot be turned into a valid slug.',
      );
    }

    const baseSlug = slug;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const product = await tx.product.create({
            data: {
              organizationId: tenant.organizationId,
              shopId,
              categoryId: input.categoryId ?? null,
              name: input.name.trim(),
              slug,
              description: input.description ?? null,
              shortDescription: input.shortDescription ?? null,
              productType,
              currency: shop.currency, // héritée, immuable ensuite
              featured: input.featured ?? false,
              createdByUserId: tenant.userId,
            },
            select: { id: true },
          });

          // Options + valeurs, avec index nom→ids pour les liaisons variantes.
          const valueIdByOptionAndValue = new Map<string, { optionId: string; valueId: string }>();
          for (const option of options) {
            const createdOption = await tx.productOption.create({
              data: {
                organizationId: tenant.organizationId,
                shopId,
                productId: product.id,
                name: option.name,
                position: option.position,
              },
              select: { id: true },
            });
            for (const [valueIndex, value] of option.values.entries()) {
              const createdValue = await tx.productOptionValue.create({
                data: { optionId: createdOption.id, value, position: valueIndex },
                select: { id: true },
              });
              valueIdByOptionAndValue.set(
                `${option.name.toLowerCase()}::${value.toLowerCase()}`,
                { optionId: createdOption.id, valueId: createdValue.id },
              );
            }
          }

          for (const variant of variants) {
            const createdVariant = await tx.productVariant.create({
              data: {
                organizationId: tenant.organizationId,
                shopId,
                productId: product.id,
                name: variant.name,
                sku: variant.sku,
                barcode: variant.barcode,
                priceMinor: variant.priceMinor,
                compareAtPriceMinor: variant.compareAtPriceMinor,
                costPriceMinor: variant.costPriceMinor,
                trackInventory: variant.trackInventory,
                allowBackorder: variant.allowBackorder,
                weightGrams: variant.weightGrams,
                sortOrder: variant.sortOrder,
                isDefault: variant.isDefault,
                combinationKey: variant.combinationKey,
              },
              select: { id: true },
            });

            if (variant.selections.length > 0) {
              await tx.productVariantOptionValue.createMany({
                data: variant.selections.map((selection) => {
                  const ids = valueIdByOptionAndValue.get(
                    `${selection.optionName.toLowerCase()}::${selection.value.toLowerCase()}`,
                  )!;
                  return {
                    variantId: createdVariant.id,
                    productId: product.id,
                    optionId: ids.optionId,
                    optionValueId: ids.valueId,
                  };
                }),
              });
            }

            if (variant.trackInventory) {
              await tx.inventoryItem.create({
                data: {
                  organizationId: tenant.organizationId,
                  shopId,
                  variantId: createdVariant.id,
                  quantityOnHand: variant.initialQuantity,
                  lowStockThreshold: variant.lowStockThreshold,
                },
                select: { id: true },
              });
              // Aucun mouvement sans changement réel : INITIAL seulement si > 0.
              if (variant.initialQuantity > 0) {
                await tx.inventoryMovement.create({
                  data: {
                    organizationId: tenant.organizationId,
                    shopId,
                    variantId: createdVariant.id,
                    type: 'INITIAL',
                    quantityDelta: variant.initialQuantity,
                    quantityBefore: 0,
                    quantityAfter: variant.initialQuantity,
                    actorUserId: tenant.userId,
                  },
                  select: { id: true },
                });
              }
            }
          }

          if (images.length > 0) {
            await tx.productImage.createMany({
              data: images.map((image) => ({
                organizationId: tenant.organizationId,
                shopId,
                productId: product.id,
                ...image,
              })),
            });
          }

          await this.auditService.record(
            {
              organizationId: tenant.organizationId,
              eventType: 'PRODUCT_CREATED',
              actorUserId: tenant.userId,
              metadata: {
                productId: product.id,
                shopId,
                name: input.name.trim(),
                slug,
                variantCount: variants.length,
                optionCount: options.length,
              },
              context,
            },
            tx,
          );

          return tx.product.findUniqueOrThrow({
            where: { id: product.id },
            select: PRODUCT_DETAIL_SELECT,
          });
        });
      } catch (error) {
        const target = uniqueViolationTarget(error);
        if (target !== null && target.includes('slug')) {
          if (slugWasProvided || attempt >= MAX_GENERATED_SLUG_ATTEMPTS) {
            throw new ProductSlugAlreadyUsedError();
          }
          slug = suffixedSlug(baseSlug, attempt + 1);
          continue;
        }
        if (target !== null) {
          translateVariantUniqueError(error);
        }
        throw error;
      }
    }
  }

  private prepareVariants(
    input: CreateProductDto,
    options: Array<{ name: string; values: string[] }>,
    productType: string,
  ): PreparedVariant[] {
    const hasOptions = options.length > 0;
    const skus = new Set<string>();
    const barcodes = new Set<string>();
    const combinationKeys = new Set<string>();
    let defaultCount = input.variants.filter((variant) => variant.isDefault === true).length;
    if (defaultCount > 1) {
      throw new ValidationError('At most one default variant is allowed.');
    }

    const prepared = input.variants.map((variant, index) => {
      // SERVICE/DIGITAL : jamais de suivi de stock dans cette phase (validé).
      const trackInventory =
        productType === 'PHYSICAL' ? (variant.trackInventory ?? true) : false;
      if (productType !== 'PHYSICAL' && variant.trackInventory === true) {
        throw new ValidationError(
          `trackInventory is not allowed for ${productType} products in this phase.`,
        );
      }
      if (!trackInventory && variant.initialQuantity !== undefined && variant.initialQuantity > 0) {
        throw new ValidationError('Initial stock requires trackInventory=true.');
      }

      const sku = normalizeSku(variant.sku);
      if (sku === null) {
        throw new InvalidSkuFormatError();
      }
      if (skus.has(sku)) {
        throw new VariantSkuAlreadyUsedError();
      }
      skus.add(sku);

      let barcode: string | null = null;
      if (variant.barcode !== undefined) {
        barcode = normalizeBarcode(variant.barcode);
        if (barcode === null) {
          throw new ValidationError('Invalid barcode: 4-50 characters, letters/digits and hyphens.');
        }
        if (barcodes.has(barcode)) {
          throw new VariantBarcodeAlreadyUsedError();
        }
        barcodes.add(barcode);
      }

      if (
        variant.compareAtPriceMinor !== undefined &&
        variant.compareAtPriceMinor <= variant.priceMinor
      ) {
        throw new ValidationError('compareAtPriceMinor must be greater than priceMinor.');
      }

      // Sélections : exactement une valeur par option du produit.
      const selections = variant.optionSelections ?? [];
      if (hasOptions) {
        if (selections.length !== options.length) {
          throw new ValidationError(
            `Variant "${variant.sku}" must select exactly one value per option.`,
          );
        }
        for (const option of options) {
          const selection = selections.find(
            (candidate) => candidate.optionName.trim().toLowerCase() === option.name.toLowerCase(),
          );
          if (!selection) {
            throw new ValidationError(
              `Variant "${variant.sku}" is missing a value for option "${option.name}".`,
            );
          }
          const valueExists = option.values.some(
            (value) => value.toLowerCase() === selection.value.trim().toLowerCase(),
          );
          if (!valueExists) {
            throw new ValidationError(
              `Unknown value "${selection.value}" for option "${option.name}".`,
            );
          }
        }
      } else if (selections.length > 0) {
        throw new ValidationError('This product has no options: optionSelections must be empty.');
      }

      const combinationKey = buildCombinationKey(
        selections.map((selection) => ({
          optionName: selection.optionName,
          value: selection.value,
        })),
      );
      if (combinationKeys.has(combinationKey)) {
        throw new DuplicateVariantCombinationError();
      }
      combinationKeys.add(combinationKey);

      const generatedName =
        selections.length > 0 ? selections.map((selection) => selection.value.trim()).join(' / ') : null;

      return {
        name: variant.name?.trim() ?? generatedName,
        sku,
        barcode,
        priceMinor: variant.priceMinor,
        compareAtPriceMinor: variant.compareAtPriceMinor ?? null,
        costPriceMinor: variant.costPriceMinor ?? null,
        trackInventory,
        allowBackorder: variant.allowBackorder ?? false,
        weightGrams: variant.weightGrams ?? null,
        sortOrder: variant.sortOrder ?? index,
        isDefault: variant.isDefault === true,
        combinationKey,
        selections: (variant.optionSelections ?? []).map((selection) => ({
          optionName: selection.optionName.trim(),
          value: selection.value.trim(),
        })),
        initialQuantity: variant.initialQuantity ?? 0,
        lowStockThreshold: variant.lowStockThreshold ?? 5,
      } satisfies PreparedVariant;
    });

    // Sans défaut explicite : la première (ordre trié) devient la DEFAULT.
    if (defaultCount === 0 && prepared.length > 0) {
      const first = [...prepared].sort((a, b) => a.sortOrder - b.sortOrder)[0];
      first.isDefault = true;
      defaultCount = 1;
    }
    return prepared;
  }

  // --------------------------------------------------------------------- read

  async list(
    tenant: TenantContext,
    shopId: string,
    query: ListProductsQueryDto,
  ): Promise<{
    rows: Array<{ product: ProductDetail; aggregates: ProductListAggregates }>;
    total: number;
  }> {
    await this.getShop(tenant, shopId);

    const { pageSql, countSql } = buildProductListQuery(tenant.organizationId, shopId, query);
    const [pageRows, countRows] = await Promise.all([
      this.prisma.$queryRaw<ProductListSqlRow[]>(pageSql),
      this.prisma.$queryRaw<Array<{ total: bigint }>>(countSql),
    ]);
    const total = Number(countRows[0]?.total ?? 0n);
    if (pageRows.length === 0) {
      return { rows: [], total };
    }

    const ids = pageRows.map((row) => row.id);
    const products = await this.prisma.product.findMany({
      where: { id: { in: ids } },
      select: PRODUCT_DETAIL_SELECT,
    });
    const productById = new Map(products.map((product) => [product.id, product]));

    const rows = pageRows
      .filter((row) => productById.has(row.id))
      .map((row) => ({
        product: productById.get(row.id)!,
        aggregates: {
          minPriceMinor: row.min_price,
          maxPriceMinor: row.max_price,
          variantCount: Number(row.variant_count),
          totalAvailable: row.total_available === null ? null : Number(row.total_available),
          stockStatus: row.stock_status,
        },
      }));
    return { rows, total };
  }

  async getDetail(
    tenant: TenantContext,
    shopId: string,
    productId: string,
  ): Promise<ProductDetail> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, organizationId: tenant.organizationId, shopId },
      select: PRODUCT_DETAIL_SELECT,
    });
    if (!product) {
      throw new ProductNotFoundError();
    }
    return product;
  }

  // ------------------------------------------------------------------- update

  async update(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    input: UpdateProductDto,
    context: AuditActionContext,
  ): Promise<ProductDetail> {
    await this.getWritableShop(tenant, shopId);
    const current = await this.getDetail(tenant, shopId, productId);
    if (current.status === 'ARCHIVED') {
      throw new ProductArchivedError();
    }

    const data: Prisma.ProductUpdateManyMutationInput & { categoryId?: string | null } = {};
    if (input.name !== undefined) {
      data.name = input.name.trim();
    }
    if (input.slug !== undefined) {
      const slug = input.slug.trim().toLowerCase();
      if (!isValidSlug(slug)) {
        throw new ValidationError(
          'Slug must be 2-50 characters, lowercase letters, digits and single hyphens.',
        );
      }
      data.slug = slug;
    }
    if (input.description !== undefined) {
      data.description = input.description;
    }
    if (input.shortDescription !== undefined) {
      data.shortDescription = input.shortDescription;
    }
    if (input.featured !== undefined) {
      data.featured = input.featured;
    }
    if (input.categoryId !== undefined) {
      if (input.categoryId !== null) {
        await this.assertAssignableCategory(tenant, shopId, input.categoryId);
      }
      data.categoryId = input.categoryId;
    }
    if (Object.keys(data).length === 0) {
      throw new ValidationError('No updatable field provided.');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.product.updateMany({
          where: {
            id: productId,
            organizationId: tenant.organizationId,
            shopId,
            status: { not: 'ARCHIVED' },
          },
          data,
        });
        if (updated.count !== 1) {
          throw new ProductArchivedError();
        }
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'PRODUCT_UPDATED',
            actorUserId: tenant.userId,
            metadata: { productId, shopId, fields: Object.keys(data) },
            context,
          },
          tx,
        );
        return tx.product.findUniqueOrThrow({
          where: { id: productId },
          select: PRODUCT_DETAIL_SELECT,
        });
      });
    } catch (error) {
      const target = uniqueViolationTarget(error);
      if (target !== null && target.includes('slug')) {
        throw new ProductSlugAlreadyUsedError();
      }
      throw error;
    }
  }

  // -------------------------------------------------------------- transitions

  /**
   * Activation avec verrou du produit (SELECT … FOR UPDATE) : sérialisée avec
   * les changements de statut de variantes — impossible d'activer pendant que
   * la dernière variante ACTIVE est désactivée en parallèle.
   */
  async activate(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    context: AuditActionContext,
  ): Promise<ProductDetail> {
    await this.getWritableShop(tenant, shopId);
    const current = await this.getDetail(tenant, shopId, productId);
    if (current.status === 'ARCHIVED') {
      throw new ProductArchivedError();
    }
    if (current.status === 'ACTIVE') {
      throw new InvalidProductStatusTransitionError('ACTIVE', 'ACTIVE');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockProductRow(tx, productId);

      const reasons: string[] = [];
      const activeVariants = await tx.productVariant.count({
        where: { productId, status: 'ACTIVE' },
      });
      if (activeVariants === 0) {
        reasons.push('at least one active variant is required');
      }
      if (current.categoryId !== null) {
        const category = await tx.productCategory.findFirst({
          where: { id: current.categoryId, shopId },
          select: { status: true },
        });
        if (category?.status === 'ARCHIVED') {
          reasons.push('the assigned category is archived');
        }
      }
      if (reasons.length > 0) {
        throw new ProductActivationRequirementsError(reasons);
      }

      const updated = await tx.product.updateMany({
        where: {
          id: productId,
          organizationId: tenant.organizationId,
          shopId,
          status: { in: ['DRAFT', 'INACTIVE'] },
        },
        data: { status: 'ACTIVE' },
      });
      if (updated.count !== 1) {
        throw new InvalidProductStatusTransitionError(current.status, 'ACTIVE');
      }

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'PRODUCT_ACTIVATED',
          actorUserId: tenant.userId,
          metadata: { productId, shopId },
          context,
        },
        tx,
      );

      return tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: PRODUCT_DETAIL_SELECT,
      });
    });
  }

  async deactivate(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    context: AuditActionContext,
  ): Promise<ProductDetail> {
    await this.getWritableShop(tenant, shopId);
    await this.getDetail(tenant, shopId, productId);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.product.updateMany({
        where: { id: productId, organizationId: tenant.organizationId, shopId, status: 'ACTIVE' },
        data: { status: 'INACTIVE' },
      });
      if (updated.count !== 1) {
        throw new InvalidProductStatusTransitionError('non-ACTIVE', 'INACTIVE');
      }
      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'PRODUCT_DEACTIVATED',
          actorUserId: tenant.userId,
          metadata: { productId, shopId },
          context,
        },
        tx,
      );
      return tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: PRODUCT_DETAIL_SELECT,
      });
    });
  }

  /**
   * Archivage terminal : produit + toutes ses variantes non archivées, dans
   * la même transaction. Stock, mouvements et images sont CONSERVÉS.
   */
  async archive(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    context: AuditActionContext,
  ): Promise<ProductDetail> {
    await this.getWritableShop(tenant, shopId);
    const current = await this.getDetail(tenant, shopId, productId);
    if (current.status === 'ARCHIVED') {
      throw new InvalidProductStatusTransitionError('ARCHIVED', 'ARCHIVED');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockProductRow(tx, productId);
      const now = new Date();

      const archived = await tx.product.updateMany({
        where: {
          id: productId,
          organizationId: tenant.organizationId,
          shopId,
          status: { not: 'ARCHIVED' },
        },
        data: { status: 'ARCHIVED', archivedAt: now },
      });
      if (archived.count !== 1) {
        throw new InvalidProductStatusTransitionError('ARCHIVED', 'ARCHIVED');
      }

      const archivedVariants = await tx.productVariant.updateMany({
        where: { productId, status: { not: 'ARCHIVED' } },
        data: { status: 'ARCHIVED', archivedAt: now, isDefault: false },
      });

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'PRODUCT_ARCHIVED',
          actorUserId: tenant.userId,
          metadata: { productId, shopId, archivedVariants: archivedVariants.count },
          context,
        },
        tx,
      );

      return tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: PRODUCT_DETAIL_SELECT,
      });
    });
  }

  // ------------------------------------------------------------------ helpers

  /** Verrou pessimiste du produit : sérialise activation/archivage/variantes. */
  async lockProductRow(tx: Prisma.TransactionClient, productId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "products" WHERE "id" = ${productId} FOR UPDATE`;
  }

  async assertAssignableCategory(
    tenant: TenantContext,
    shopId: string,
    categoryId: string,
  ): Promise<void> {
    const category = await this.prisma.productCategory.findFirst({
      where: { id: categoryId, organizationId: tenant.organizationId, shopId },
      select: { status: true },
    });
    if (!category) {
      throw new CategoryNotFoundError();
    }
    if (category.status === 'ARCHIVED') {
      throw new CategoryArchivedError();
    }
  }

  async getShop(tenant: TenantContext, shopId: string) {
    const shop = await this.prisma.shop.findFirst({
      where: { id: shopId, organizationId: tenant.organizationId },
      select: { id: true, status: true, currency: true },
    });
    if (!shop) {
      throw new ShopNotFoundError();
    }
    return shop;
  }

  async getWritableShop(tenant: TenantContext, shopId: string) {
    const shop = await this.getShop(tenant, shopId);
    if (shop.status === 'ARCHIVED') {
      throw new ShopArchivedError();
    }
    return shop;
  }
}
