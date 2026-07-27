import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import type { InventoryMovementType } from '@whauto/database';
import {
  computeQuantityAvailable,
  computeVariantStockStatus,
  InsufficientStockError,
  InvalidInventoryAdjustmentError,
  InventoryConcurrencyError,
  InventoryNotTrackedError,
  ShopArchivedError,
  ShopNotFoundError,
  VariantArchivedError,
  VariantNotFoundError,
} from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import type { AdjustInventoryDto, InventoryRowDto, ListInventoryQueryDto } from './dto/inventory.dto';

interface AdjustResult {
  row: InventoryRowDto;
  movement: {
    type: InventoryMovementType;
    quantityDelta: number;
    quantityBefore: number;
    quantityAfter: number;
  };
}

const MOVEMENT_SELECT = {
  id: true,
  variantId: true,
  type: true,
  quantityDelta: true,
  quantityBefore: true,
  quantityAfter: true,
  reason: true,
  referenceType: true,
  referenceId: true,
  createdAt: true,
  actor: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.InventoryMovementSelect;

export type MovementRow = Prisma.InventoryMovementGetPayload<{ select: typeof MOVEMENT_SELECT }>;

const INVENTORY_ITEM_SELECT = {
  variantId: true,
  quantityOnHand: true,
  quantityReserved: true,
  lowStockThreshold: true,
  version: true,
  updatedAt: true,
  variant: {
    select: {
      id: true,
      productId: true,
      name: true,
      sku: true,
      status: true,
      priceMinor: true,
      trackInventory: true,
      allowBackorder: true,
      product: { select: { name: true, currency: true } },
    },
  },
} satisfies Prisma.InventoryItemSelect;

type InventoryItemRow = Prisma.InventoryItemGetPayload<{ select: typeof INVENTORY_ITEM_SELECT }>;

function toRow(item: InventoryItemRow): InventoryRowDto {
  const stockStatus = computeVariantStockStatus({
    trackInventory: item.variant.trackInventory,
    allowBackorder: item.variant.allowBackorder,
    quantityOnHand: item.quantityOnHand,
    quantityReserved: item.quantityReserved,
    lowStockThreshold: item.lowStockThreshold,
  });
  return {
    variantId: item.variantId,
    productId: item.variant.productId,
    productName: item.variant.product.name,
    variantName: item.variant.name,
    sku: item.variant.sku,
    currency: item.variant.product.currency,
    priceMinor: item.variant.priceMinor,
    quantityOnHand: item.quantityOnHand,
    quantityReserved: item.quantityReserved,
    quantityAvailable: computeQuantityAvailable(item),
    lowStockThreshold: item.lowStockThreshold,
    allowBackorder: item.variant.allowBackorder,
    trackInventory: item.variant.trackInventory,
    version: item.version,
    stockStatus,
    updatedAt: item.updatedAt,
  };
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
  ) {}

  // --------------------------------------------------------------------- list

  /**
   * Vue stock de la Shop. Le filtre stockStatus s'applique AVANT la
   * pagination, en SQL (exigence validée) : la sélection des variantId de la
   * page est faite par PostgreSQL avec le même CASE de statut que
   * computeVariantStockStatus, puis les lignes complètes sont chargées.
   */
  async list(
    tenant: TenantContext,
    shopId: string,
    query: ListInventoryQueryDto,
  ): Promise<{ items: InventoryRowDto[]; total: number }> {
    await this.getShop(tenant, shopId);

    const conditions: Prisma.Sql[] = [
      Prisma.sql`i."organizationId" = ${tenant.organizationId}`,
      Prisma.sql`i."shopId" = ${shopId}`,
    ];
    if (query.includeArchived !== true) {
      conditions.push(Prisma.sql`v."status" <> 'ARCHIVED'`);
    }
    if (query.search !== undefined && query.search.trim() !== '') {
      const like = `%${query.search.trim()}%`;
      conditions.push(Prisma.sql`(p."name" ILIKE ${like} OR v."sku" ILIKE ${like})`);
    }

    const statusExpr = Prisma.sql`
      CASE
        WHEN NOT v."trackInventory" THEN 'NOT_TRACKED'
        WHEN i."quantityOnHand" - i."quantityReserved" > i."lowStockThreshold" THEN 'IN_STOCK'
        WHEN i."quantityOnHand" - i."quantityReserved" > 0 THEN 'LOW_STOCK'
        WHEN v."allowBackorder" THEN 'BACKORDERED'
        ELSE 'OUT_OF_STOCK'
      END`;

    const where = Prisma.join(conditions, ' AND ');
    const statusFilter =
      query.stockStatus !== undefined
        ? Prisma.sql`WHERE q.stock_status = ${query.stockStatus}`
        : Prisma.empty;

    const base = Prisma.sql`
      WITH q AS (
        SELECT i."variantId", p."name" AS product_name, v."sortOrder" AS sort_order,
               (${statusExpr}) AS stock_status
        FROM "inventory_items" i
        JOIN "product_variants" v ON v."id" = i."variantId"
        JOIN "products" p ON p."id" = v."productId"
        WHERE ${where}
      )
    `;

    const [pageRows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ variantId: string }>>(Prisma.sql`
        ${base}
        SELECT q."variantId" FROM q ${statusFilter}
        ORDER BY q.product_name ASC, q.sort_order ASC, q."variantId" ASC
        LIMIT ${query.limit} OFFSET ${query.skip}
      `),
      this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
        ${base}
        SELECT COUNT(*)::bigint AS total FROM q ${statusFilter}
      `),
    ]);

    const total = Number(countRows[0]?.total ?? 0n);
    if (pageRows.length === 0) {
      return { items: [], total };
    }
    const ids = pageRows.map((row) => row.variantId);
    const items = await this.prisma.inventoryItem.findMany({
      where: { variantId: { in: ids } },
      select: INVENTORY_ITEM_SELECT,
    });
    const byId = new Map(items.map((item) => [item.variantId, item]));
    return {
      items: ids.filter((id) => byId.has(id)).map((id) => toRow(byId.get(id)!)),
      total,
    };
  }

  // ------------------------------------------------------------------ getters

  async getForVariant(
    tenant: TenantContext,
    shopId: string,
    variantId: string,
  ): Promise<InventoryRowDto> {
    await this.getShop(tenant, shopId);
    const item = await this.getItemScoped(tenant, shopId, variantId);
    return toRow(item);
  }

  async listMovements(
    tenant: TenantContext,
    shopId: string,
    variantId: string,
    pagination: { page: number; limit: number; skip: number },
  ): Promise<{ items: MovementRow[]; total: number }> {
    await this.getShop(tenant, shopId);
    await this.getVariantScoped(tenant, shopId, variantId);

    const where = { variantId, organizationId: tenant.organizationId, shopId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.inventoryMovement.findMany({
        where,
        select: MOVEMENT_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);
    return { items, total };
  }

  // ------------------------------------------------------------------- adjust

  async adjust(
    tenant: TenantContext,
    shopId: string,
    variantId: string,
    input: AdjustInventoryDto,
    context: AuditActionContext,
  ): Promise<AdjustResult> {
    const shop = await this.getShop(tenant, shopId);
    if (shop.status === 'ARCHIVED') {
      throw new ShopArchivedError();
    }
    const variant = await this.getVariantScoped(tenant, shopId, variantId);
    if (variant.status === 'ARCHIVED') {
      throw new VariantArchivedError();
    }
    if (!variant.trackInventory) {
      throw new InventoryNotTrackedError();
    }

    const movement =
      input.type === 'ADJUSTMENT'
        ? await this.applyTargetQuantity(tenant, shopId, variantId, input, context)
        : await this.applyDelta(tenant, shopId, variantId, input, context);

    const item = await this.getItemScoped(tenant, shopId, variantId);
    return { row: toRow(item), movement };
  }

  /**
   * RESTOCK/DAMAGE — UPDATE SQL ATOMIQUE conditionnel avec RETURNING : deux
   * ajustements simultanés s'additionnent toujours (jamais de read-then-write).
   * quantityOnHand ne descend JAMAIS sous 0 (condition + CHECK SQL) : un
   * DAMAGE trop grand échoue proprement (InsufficientStockError).
   */
  private async applyDelta(
    tenant: TenantContext,
    shopId: string,
    variantId: string,
    input: AdjustInventoryDto,
    context: AuditActionContext,
  ): Promise<AdjustResult['movement']> {
    const quantity = input.quantity!;
    // Décision validée : RESTOCK stocke un delta POSITIF, DAMAGE un delta NÉGATIF.
    const delta = input.type === 'RESTOCK' ? quantity : -quantity;
    const reason = input.type === 'DAMAGE' ? input.reason! : (input.restockReason ?? null);

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ quantityOnHand: number }>>`
        UPDATE "inventory_items"
        SET "quantityOnHand" = "quantityOnHand" + ${delta},
            "version" = "version" + 1,
            "updatedAt" = NOW()
        WHERE "variantId" = ${variantId}
          AND "quantityOnHand" + ${delta} >= 0
        RETURNING "quantityOnHand"
      `;
      if (rows.length === 0) {
        throw new InsufficientStockError();
      }
      const quantityAfter = rows[0].quantityOnHand;
      const quantityBefore = quantityAfter - delta;

      await tx.inventoryMovement.create({
        data: {
          organizationId: tenant.organizationId,
          shopId,
          variantId,
          type: input.type as InventoryMovementType,
          quantityDelta: delta,
          quantityBefore,
          quantityAfter,
          reason,
          actorUserId: tenant.userId,
        },
        select: { id: true },
      });

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'INVENTORY_ADJUSTED',
          actorUserId: tenant.userId,
          metadata: { variantId, type: input.type, quantityDelta: delta },
          context,
        },
        tx,
      );

      return { type: input.type as InventoryMovementType, quantityDelta: delta, quantityBefore, quantityAfter };
    });
  }

  /**
   * ADJUSTMENT (quantité cible) — verrou pessimiste ligne (FOR UPDATE) +
   * vérification du verrou OPTIMISTE client (expectedVersion) : si le stock a
   * changé depuis la lecture de l'utilisateur, 409 INVENTORY_CONCURRENCY —
   * l'UI recharge et redemande confirmation. Delta stocké = after − before.
   */
  private async applyTargetQuantity(
    tenant: TenantContext,
    shopId: string,
    variantId: string,
    input: AdjustInventoryDto,
    context: AuditActionContext,
  ): Promise<AdjustResult['movement']> {
    const newQuantity = input.newQuantityOnHand!;

    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ quantityOnHand: number; version: number }>>`
        SELECT "quantityOnHand", "version"
        FROM "inventory_items"
        WHERE "variantId" = ${variantId}
        FOR UPDATE
      `;
      if (rows.length === 0) {
        throw new InventoryNotTrackedError();
      }
      const current = rows[0];
      if (current.version !== input.expectedVersion) {
        throw new InventoryConcurrencyError();
      }
      const delta = newQuantity - current.quantityOnHand;
      if (delta === 0) {
        throw new InvalidInventoryAdjustmentError('the quantity is unchanged — no movement created');
      }

      await tx.inventoryItem.update({
        where: { variantId },
        data: { quantityOnHand: newQuantity, version: { increment: 1 } },
        select: { variantId: true },
      });

      await tx.inventoryMovement.create({
        data: {
          organizationId: tenant.organizationId,
          shopId,
          variantId,
          type: 'ADJUSTMENT',
          quantityDelta: delta,
          quantityBefore: current.quantityOnHand,
          quantityAfter: newQuantity,
          reason: input.reason!,
          actorUserId: tenant.userId,
        },
        select: { id: true },
      });

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'INVENTORY_ADJUSTED',
          actorUserId: tenant.userId,
          metadata: { variantId, type: 'ADJUSTMENT', quantityDelta: delta },
          context,
        },
        tx,
      );

      return {
        type: 'ADJUSTMENT' as InventoryMovementType,
        quantityDelta: delta,
        quantityBefore: current.quantityOnHand,
        quantityAfter: newQuantity,
      };
    });
  }

  // ------------------------------------------------------------------ helpers

  private async getShop(tenant: TenantContext, shopId: string) {
    const shop = await this.prisma.shop.findFirst({
      where: { id: shopId, organizationId: tenant.organizationId },
      select: { id: true, status: true },
    });
    if (!shop) {
      throw new ShopNotFoundError();
    }
    return shop;
  }

  private async getVariantScoped(tenant: TenantContext, shopId: string, variantId: string) {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, organizationId: tenant.organizationId, shopId },
      select: { id: true, status: true, trackInventory: true },
    });
    if (!variant) {
      throw new VariantNotFoundError();
    }
    return variant;
  }

  private async getItemScoped(
    tenant: TenantContext,
    shopId: string,
    variantId: string,
  ): Promise<InventoryItemRow> {
    const item = await this.prisma.inventoryItem.findFirst({
      where: { variantId, organizationId: tenant.organizationId, shopId },
      select: INVENTORY_ITEM_SELECT,
    });
    if (!item) {
      throw new InventoryNotTrackedError();
    }
    return item;
  }
}
