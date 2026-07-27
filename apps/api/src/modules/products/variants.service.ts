import { Injectable } from '@nestjs/common';
import type { Prisma, ProductVariantStatus } from '@whauto/database';
import {
  buildCombinationKey,
  CannotArchiveLastActiveVariantError,
  InvalidSkuFormatError,
  normalizeBarcode,
  normalizeSku,
  OptionInUseError,
  ProductArchivedError,
  ValidationError,
  VariantArchivedError,
  VariantNotFoundError,
} from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import type {
  AddOptionValueDto,
  CreateVariantDto,
  ReplaceImagesDto,
  UpdateVariantDto,
} from './dto/product-inputs.dto';
import { PRODUCT_DETAIL_SELECT, VARIANT_FULL_SELECT } from './products.mapper';
import type { ProductDetail, VariantFull } from './products.mapper';
import { prepareImages, ProductsService, translateVariantUniqueError } from './products.service';

/**
 * Variantes : routes UNITAIRES uniquement (décision validée) — jamais de
 * remplacement global destructif. Les variantes porteuses de stock et de
 * mouvements conservent leur id ; toute modification de combinaison passe par
 * une création + un archivage EXPLICITES, transactionnels et audités.
 * La structure des combinaisons d'une variante existante est immuable.
 */
@Injectable()
export class VariantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productsService: ProductsService,
    private readonly auditService: OrganizationAuditService,
  ) {}

  // ------------------------------------------------------------------- create

  async create(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    input: CreateVariantDto,
    context: AuditActionContext,
  ): Promise<VariantFull> {
    await this.productsService.getWritableShop(tenant, shopId);
    const product = await this.productsService.getDetail(tenant, shopId, productId);
    if (product.status === 'ARCHIVED') {
      throw new ProductArchivedError();
    }
    if (product.productType !== 'PHYSICAL' && input.trackInventory === true) {
      throw new ValidationError(
        `trackInventory is not allowed for ${product.productType} products in this phase.`,
      );
    }
    const trackInventory =
      product.productType === 'PHYSICAL' ? (input.trackInventory ?? true) : false;

    const sku = normalizeSku(input.sku);
    if (sku === null) {
      throw new InvalidSkuFormatError();
    }
    let barcode: string | null = null;
    if (input.barcode !== undefined) {
      barcode = normalizeBarcode(input.barcode);
      if (barcode === null) {
        throw new ValidationError('Invalid barcode: 4-50 characters, letters/digits and hyphens.');
      }
    }
    if (input.compareAtPriceMinor !== undefined && input.compareAtPriceMinor <= input.priceMinor) {
      throw new ValidationError('compareAtPriceMinor must be greater than priceMinor.');
    }

    // Sélections : une valeur EXISTANTE par option du produit.
    const selections = input.optionSelections ?? [];
    const links: Array<{ optionId: string; optionValueId: string }> = [];
    if (product.options.length > 0) {
      if (selections.length !== product.options.length) {
        throw new ValidationError('The variant must select exactly one value per option.');
      }
      for (const option of product.options) {
        const selection = selections.find(
          (candidate) => candidate.optionName.trim().toLowerCase() === option.name.toLowerCase(),
        );
        if (!selection) {
          throw new ValidationError(`Missing a value for option "${option.name}".`);
        }
        const value = option.values.find(
          (candidate) => candidate.value.toLowerCase() === selection.value.trim().toLowerCase(),
        );
        if (!value) {
          throw new ValidationError(
            `Unknown value "${selection.value}" for option "${option.name}" — add it to the option first.`,
          );
        }
        links.push({ optionId: option.id, optionValueId: value.id });
      }
    } else if (selections.length > 0) {
      throw new ValidationError('This product has no options: optionSelections must be empty.');
    }

    const combinationKey = buildCombinationKey(
      selections.map((selection) => ({ optionName: selection.optionName, value: selection.value })),
    );
    const generatedName =
      selections.length > 0 ? selections.map((selection) => selection.value.trim()).join(' / ') : null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.productsService.lockProductRow(tx, productId);

        if (input.isDefault === true) {
          await tx.productVariant.updateMany({
            where: { productId, isDefault: true },
            data: { isDefault: false },
          });
        }

        const variant = await tx.productVariant.create({
          data: {
            organizationId: tenant.organizationId,
            shopId,
            productId,
            name: input.name?.trim() ?? generatedName,
            sku,
            barcode,
            priceMinor: input.priceMinor,
            compareAtPriceMinor: input.compareAtPriceMinor ?? null,
            costPriceMinor: input.costPriceMinor ?? null,
            trackInventory,
            allowBackorder: input.allowBackorder ?? false,
            weightGrams: input.weightGrams ?? null,
            sortOrder: input.sortOrder ?? 0,
            isDefault: input.isDefault === true,
            combinationKey,
          },
          select: { id: true },
        });

        if (links.length > 0) {
          await tx.productVariantOptionValue.createMany({
            data: links.map((link) => ({ variantId: variant.id, productId, ...link })),
          });
        }

        if (trackInventory) {
          const initialQuantity = input.initialQuantity ?? 0;
          await tx.inventoryItem.create({
            data: {
              organizationId: tenant.organizationId,
              shopId,
              variantId: variant.id,
              quantityOnHand: initialQuantity,
              lowStockThreshold: input.lowStockThreshold ?? 5,
            },
            select: { id: true },
          });
          if (initialQuantity > 0) {
            await tx.inventoryMovement.create({
              data: {
                organizationId: tenant.organizationId,
                shopId,
                variantId: variant.id,
                type: 'INITIAL',
                quantityDelta: initialQuantity,
                quantityBefore: 0,
                quantityAfter: initialQuantity,
                actorUserId: tenant.userId,
              },
              select: { id: true },
            });
          }
        }

        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'VARIANT_CREATED',
            actorUserId: tenant.userId,
            metadata: { productId, variantId: variant.id, shopId, sku },
            context,
          },
          tx,
        );

        return tx.productVariant.findUniqueOrThrow({
          where: { id: variant.id },
          select: VARIANT_FULL_SELECT,
        });
      });
    } catch (error) {
      translateVariantUniqueError(error);
    }
  }

  // ------------------------------------------------------------------- update

  async update(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    variantId: string,
    input: UpdateVariantDto,
    context: AuditActionContext,
  ): Promise<VariantFull> {
    await this.productsService.getWritableShop(tenant, shopId);
    const product = await this.productsService.getDetail(tenant, shopId, productId);
    if (product.status === 'ARCHIVED') {
      throw new ProductArchivedError();
    }
    const current = product.variants.find((variant) => variant.id === variantId);
    if (!current) {
      throw new VariantNotFoundError();
    }
    if (current.status === 'ARCHIVED') {
      throw new VariantArchivedError();
    }

    const data: Prisma.ProductVariantUpdateManyMutationInput = {};
    if (input.name !== undefined) {
      data.name = input.name === null ? null : input.name.trim();
    }
    if (input.sku !== undefined) {
      const sku = normalizeSku(input.sku);
      if (sku === null) {
        throw new InvalidSkuFormatError();
      }
      data.sku = sku;
    }
    if (input.barcode !== undefined) {
      if (input.barcode === null) {
        data.barcode = null;
      } else {
        const barcode = normalizeBarcode(input.barcode);
        if (barcode === null) {
          throw new ValidationError('Invalid barcode: 4-50 characters, letters/digits and hyphens.');
        }
        data.barcode = barcode;
      }
    }
    if (input.priceMinor !== undefined) {
      data.priceMinor = input.priceMinor;
    }
    if (input.compareAtPriceMinor !== undefined) {
      const price = input.priceMinor ?? current.priceMinor;
      if (input.compareAtPriceMinor !== null && input.compareAtPriceMinor <= price) {
        throw new ValidationError('compareAtPriceMinor must be greater than priceMinor.');
      }
      data.compareAtPriceMinor = input.compareAtPriceMinor;
    } else if (
      input.priceMinor !== undefined &&
      current.compareAtPriceMinor !== null &&
      current.compareAtPriceMinor <= input.priceMinor
    ) {
      throw new ValidationError('compareAtPriceMinor must remain greater than priceMinor.');
    }
    if (input.costPriceMinor !== undefined) {
      data.costPriceMinor = input.costPriceMinor;
    }
    if (input.allowBackorder !== undefined) {
      data.allowBackorder = input.allowBackorder;
    }
    if (input.weightGrams !== undefined) {
      data.weightGrams = input.weightGrams;
    }
    if (input.sortOrder !== undefined) {
      data.sortOrder = input.sortOrder;
    }
    if (input.trackInventory !== undefined) {
      if (input.trackInventory && product.productType !== 'PHYSICAL') {
        throw new ValidationError(
          `trackInventory is not allowed for ${product.productType} products in this phase.`,
        );
      }
      data.trackInventory = input.trackInventory;
    }
    if (input.isDefault === false && current.isDefault) {
      throw new ValidationError('Promote another variant as default instead of unsetting this one.');
    }
    const promoteDefault = input.isDefault === true && !current.isDefault;

    if (Object.keys(data).length === 0 && !promoteDefault) {
      throw new ValidationError('No updatable field provided.');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.productsService.lockProductRow(tx, productId);

        if (promoteDefault) {
          await tx.productVariant.updateMany({
            where: { productId, isDefault: true },
            data: { isDefault: false },
          });
          (data as Record<string, unknown>).isDefault = true;
        }

        const updated = await tx.productVariant.updateMany({
          where: { id: variantId, productId, status: { not: 'ARCHIVED' } },
          data,
        });
        if (updated.count !== 1) {
          throw new VariantArchivedError();
        }

        // Passage à trackInventory=true : l'InventoryItem naît à 0 (aucun
        // mouvement sans changement réel). false : l'item est CONSERVÉ (historique).
        if (input.trackInventory === true) {
          await tx.inventoryItem.upsert({
            where: { variantId },
            update: {},
            create: {
              organizationId: tenant.organizationId,
              shopId,
              variantId,
              quantityOnHand: 0,
            },
            select: { id: true },
          });
        }

        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'VARIANT_UPDATED',
            actorUserId: tenant.userId,
            metadata: {
              productId,
              variantId,
              shopId,
              fields: [...Object.keys(data), ...(promoteDefault ? ['isDefault'] : [])],
            },
            context,
          },
          tx,
        );

        return tx.productVariant.findUniqueOrThrow({
          where: { id: variantId },
          select: VARIANT_FULL_SELECT,
        });
      });
    } catch (error) {
      translateVariantUniqueError(error);
    }
  }

  // -------------------------------------------------------------- transitions

  async activate(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    variantId: string,
    context: AuditActionContext,
  ): Promise<VariantFull> {
    return this.setStatus(tenant, shopId, productId, variantId, 'ACTIVE', context);
  }

  async deactivate(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    variantId: string,
    context: AuditActionContext,
  ): Promise<VariantFull> {
    return this.setStatus(tenant, shopId, productId, variantId, 'INACTIVE', context);
  }

  async archive(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    variantId: string,
    context: AuditActionContext,
  ): Promise<VariantFull> {
    return this.setStatus(tenant, shopId, productId, variantId, 'ARCHIVED', context);
  }

  /**
   * Transitions sous verrou du produit (FOR UPDATE) — protections validées :
   * - dernière variante ACTIVE d'un produit ACTIVE : ni désactivable ni
   *   archivable (désactiver le produit ou activer une autre variante d'abord),
   *   y compris sous deux requêtes concurrentes (le verrou sérialise) ;
   * - dernière variante non archivée d'un produit vivant : non archivable
   *   (archiver le produit à la place) ;
   * - archivage de la DEFAULT : promotion transactionnelle d'une remplaçante
   *   (ACTIVE d'abord, sinon INACTIVE — ordre sortOrder, createdAt, id).
   */
  private async setStatus(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    variantId: string,
    target: ProductVariantStatus,
    context: AuditActionContext,
  ): Promise<VariantFull> {
    await this.productsService.getWritableShop(tenant, shopId);
    const product = await this.productsService.getDetail(tenant, shopId, productId);
    if (product.status === 'ARCHIVED') {
      throw new ProductArchivedError();
    }
    const current = product.variants.find((variant) => variant.id === variantId);
    if (!current) {
      throw new VariantNotFoundError();
    }
    if (current.status === 'ARCHIVED') {
      throw new VariantArchivedError();
    }
    if (current.status === target) {
      throw new ValidationError(`The variant is already ${target}.`);
    }

    return this.prisma.$transaction(async (tx) => {
      await this.productsService.lockProductRow(tx, productId);

      // Relire SOUS verrou : l'état hors transaction peut être périmé.
      const lockedProduct = await tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: { status: true },
      });

      if (target !== 'ACTIVE') {
        if (lockedProduct.status === 'ACTIVE') {
          const otherActive = await tx.productVariant.count({
            where: { productId, status: 'ACTIVE', id: { not: variantId } },
          });
          if (otherActive === 0 && current.status === 'ACTIVE') {
            throw new CannotArchiveLastActiveVariantError();
          }
        }
        if (target === 'ARCHIVED') {
          const otherLive = await tx.productVariant.count({
            where: { productId, status: { not: 'ARCHIVED' }, id: { not: variantId } },
          });
          if (otherLive === 0) {
            // Un produit vivant doit garder au moins une variante vivante.
            throw new CannotArchiveLastActiveVariantError();
          }
        }
      }

      const data: Prisma.ProductVariantUpdateManyMutationInput =
        target === 'ARCHIVED'
          ? { status: target, archivedAt: new Date(), isDefault: false }
          : { status: target };

      const updated = await tx.productVariant.updateMany({
        where: { id: variantId, productId, status: current.status },
        data,
      });
      if (updated.count !== 1) {
        throw new VariantArchivedError();
      }

      // Promotion de la remplaçante si la DEFAULT vient d'être archivée.
      let promotedVariantId: string | null = null;
      if (target === 'ARCHIVED' && current.isDefault) {
        for (const status of ['ACTIVE', 'INACTIVE'] as const) {
          const candidate = await tx.productVariant.findFirst({
            where: { productId, status },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true },
          });
          if (candidate) {
            await tx.productVariant.update({
              where: { id: candidate.id },
              data: { isDefault: true },
              select: { id: true },
            });
            promotedVariantId = candidate.id;
            break;
          }
        }
      }

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: target === 'ARCHIVED' ? 'VARIANT_ARCHIVED' : 'VARIANT_UPDATED',
          actorUserId: tenant.userId,
          metadata: {
            productId,
            variantId,
            shopId,
            from: current.status,
            to: target,
            promotedVariantId,
          },
          context,
        },
        tx,
      );

      return tx.productVariant.findUniqueOrThrow({
        where: { id: variantId },
        select: VARIANT_FULL_SELECT,
      });
    });
  }

  // ------------------------------------------------------------------ options

  /** Ajout d'une valeur à une option existante — seule évolution SANS danger. */
  async addOptionValue(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    optionId: string,
    input: AddOptionValueDto,
    context: AuditActionContext,
  ): Promise<ProductDetail> {
    await this.productsService.getWritableShop(tenant, shopId);
    const product = await this.productsService.getDetail(tenant, shopId, productId);
    if (product.status === 'ARCHIVED') {
      throw new ProductArchivedError();
    }
    const option = product.options.find((candidate) => candidate.id === optionId);
    if (!option) {
      throw new ValidationError('Unknown option for this product.');
    }
    const value = input.value.trim();
    if (option.values.some((candidate) => candidate.value.toLowerCase() === value.toLowerCase())) {
      throw new ValidationError(`Value "${value}" already exists for option "${option.name}".`);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.productOptionValue.create({
        data: { optionId, value, position: option.values.length },
        select: { id: true },
      });
      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'PRODUCT_UPDATED',
          actorUserId: tenant.userId,
          metadata: { productId, shopId, fields: ['optionValues'], optionId },
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
   * Suppression d'option/valeur : REFUSÉE tant qu'une variante NON ARCHIVÉE
   * l'utilise (décision validée — aucune suppression silencieuse, jamais de
   * recréation des variantes porteuses de stock). Après archivage explicite
   * des variantes concernées, la suppression devient possible.
   */
  async deleteOption(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    optionId: string,
    context: AuditActionContext,
  ): Promise<ProductDetail> {
    await this.productsService.getWritableShop(tenant, shopId);
    const product = await this.productsService.getDetail(tenant, shopId, productId);
    if (product.status === 'ARCHIVED') {
      throw new ProductArchivedError();
    }
    if (!product.options.some((candidate) => candidate.id === optionId)) {
      throw new ValidationError('Unknown option for this product.');
    }

    const inUse = await this.prisma.productVariantOptionValue.count({
      where: { optionId, variant: { status: { not: 'ARCHIVED' } } },
    });
    if (inUse > 0) {
      throw new OptionInUseError();
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.productOption.delete({ where: { id: optionId }, select: { id: true } });
      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'PRODUCT_UPDATED',
          actorUserId: tenant.userId,
          metadata: { productId, shopId, fields: ['options'], deletedOptionId: optionId },
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

  async deleteOptionValue(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    optionId: string,
    valueId: string,
    context: AuditActionContext,
  ): Promise<ProductDetail> {
    await this.productsService.getWritableShop(tenant, shopId);
    const product = await this.productsService.getDetail(tenant, shopId, productId);
    if (product.status === 'ARCHIVED') {
      throw new ProductArchivedError();
    }
    const option = product.options.find((candidate) => candidate.id === optionId);
    if (!option || !option.values.some((candidate) => candidate.id === valueId)) {
      throw new ValidationError('Unknown option value for this product.');
    }

    const inUse = await this.prisma.productVariantOptionValue.count({
      where: { optionValueId: valueId, variant: { status: { not: 'ARCHIVED' } } },
    });
    if (inUse > 0) {
      throw new OptionInUseError();
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.productOptionValue.delete({ where: { id: valueId }, select: { id: true } });
      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'PRODUCT_UPDATED',
          actorUserId: tenant.userId,
          metadata: { productId, shopId, fields: ['optionValues'], deletedValueId: valueId },
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

  // ------------------------------------------------------------------- images

  /**
   * Remplacement complet de la galerie — sûr contrairement aux variantes :
   * les images ne portent ni stock ni historique. Positions déterministes,
   * une principale maximum (index partiel en garde-fou).
   */
  async replaceImages(
    tenant: TenantContext,
    shopId: string,
    productId: string,
    input: ReplaceImagesDto,
    context: AuditActionContext,
  ): Promise<ProductDetail> {
    await this.productsService.getWritableShop(tenant, shopId);
    const product = await this.productsService.getDetail(tenant, shopId, productId);
    if (product.status === 'ARCHIVED') {
      throw new ProductArchivedError();
    }
    const images = prepareImages(input.images);

    return this.prisma.$transaction(async (tx) => {
      await tx.productImage.deleteMany({ where: { productId } });
      if (images.length > 0) {
        await tx.productImage.createMany({
          data: images.map((image) => ({
            organizationId: tenant.organizationId,
            shopId,
            productId,
            ...image,
          })),
        });
      }
      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'PRODUCT_UPDATED',
          actorUserId: tenant.userId,
          metadata: { productId, shopId, fields: ['images'], imageCount: images.length },
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
}
