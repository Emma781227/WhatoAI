import {
  InsufficientStockError,
  InvalidInventoryAdjustmentError,
  InventoryConcurrencyError,
  InventoryNotTrackedError,
  VariantArchivedError,
} from '@whauto/shared';

import { ROLE_PERMISSIONS } from '../../common/tenant/permissions';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import type { PrismaService } from '../../prisma/prisma.service';
import type { OrganizationAuditService } from '../organizations/organization-audit.service';
import type { AdjustInventoryDto } from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

const TENANT: TenantContext = {
  userId: 'user-1',
  organizationId: 'org-1',
  membershipId: 'membership-1',
  role: 'ADMIN',
  permissions: ROLE_PERMISSIONS.ADMIN,
};

function buildService() {
  const tx = {
    $queryRaw: jest.fn(),
    inventoryItem: { update: jest.fn().mockResolvedValue({}) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({ id: 'mov-1' }) },
  };
  const prisma = {
    shop: { findFirst: jest.fn().mockResolvedValue({ id: 'shop-1', status: 'ACTIVE' }) },
    productVariant: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'var-1', status: 'ACTIVE', trackInventory: true }),
    },
    inventoryItem: {
      findFirst: jest.fn().mockResolvedValue({
        variantId: 'var-1',
        quantityOnHand: 10,
        quantityReserved: 0,
        lowStockThreshold: 5,
        version: 3,
        updatedAt: new Date(),
        variant: {
          id: 'var-1',
          productId: 'prod-1',
          name: null,
          sku: 'SKU-1',
          status: 'ACTIVE',
          priceMinor: 5000,
          trackInventory: true,
          allowBackorder: false,
          product: { name: 'Produit', currency: 'XAF' },
        },
      }),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  };
  const auditService = { record: jest.fn().mockResolvedValue({}) };
  const service = new InventoryService(
    prisma as unknown as PrismaService,
    auditService as unknown as OrganizationAuditService,
  );
  return { service, prisma, tx, auditService };
}

const restock = (quantity: number): AdjustInventoryDto =>
  ({ type: 'RESTOCK', quantity }) as AdjustInventoryDto;
const damage = (quantity: number): AdjustInventoryDto =>
  ({ type: 'DAMAGE', quantity, reason: 'Colis endommagé' }) as AdjustInventoryDto;

describe('InventoryService.adjust — garde-fous', () => {
  it('variante archivée refusée', async () => {
    const { service, prisma } = buildService();
    prisma.productVariant.findFirst.mockResolvedValue({
      id: 'var-1',
      status: 'ARCHIVED',
      trackInventory: true,
    });
    await expect(service.adjust(TENANT, 'shop-1', 'var-1', restock(5), {})).rejects.toThrow(
      VariantArchivedError,
    );
  });

  it('trackInventory=false refusé (SERVICE/DIGITAL inclus — aucun InventoryItem)', async () => {
    const { service, prisma } = buildService();
    prisma.productVariant.findFirst.mockResolvedValue({
      id: 'var-1',
      status: 'ACTIVE',
      trackInventory: false,
    });
    await expect(service.adjust(TENANT, 'shop-1', 'var-1', restock(5), {})).rejects.toThrow(
      InventoryNotTrackedError,
    );
  });
});

describe('InventoryService — deltas atomiques (RESTOCK/DAMAGE)', () => {
  it('RESTOCK stocke un delta POSITIF (before/after déduits du RETURNING)', async () => {
    const { service, tx } = buildService();
    tx.$queryRaw.mockResolvedValue([{ quantityOnHand: 15 }]);

    const result = await service.adjust(TENANT, 'shop-1', 'var-1', restock(5), {});

    expect(result.movement).toMatchObject({
      type: 'RESTOCK',
      quantityDelta: 5,
      quantityBefore: 10,
      quantityAfter: 15,
    });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ quantityDelta: 5 }) }),
    );
  });

  it('DAMAGE reçoit une quantité positive mais stocke un delta NÉGATIF', async () => {
    const { service, tx } = buildService();
    tx.$queryRaw.mockResolvedValue([{ quantityOnHand: 7 }]);

    const result = await service.adjust(TENANT, 'shop-1', 'var-1', damage(3), {});

    expect(result.movement).toMatchObject({
      type: 'DAMAGE',
      quantityDelta: -3,
      quantityBefore: 10,
      quantityAfter: 7,
    });
  });

  it('quantityOnHand ne devient JAMAIS négatif : UPDATE conditionnel → InsufficientStockError', async () => {
    const { service, tx } = buildService();
    tx.$queryRaw.mockResolvedValue([]); // condition "onHand + delta >= 0" non satisfaite

    await expect(service.adjust(TENANT, 'shop-1', 'var-1', damage(999), {})).rejects.toThrow(
      InsufficientStockError,
    );
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled(); // rien d'écrit
  });
});

describe('InventoryService — ADJUSTMENT (quantité cible, verrou optimiste)', () => {
  const adjustment = (newQuantityOnHand: number, expectedVersion: number): AdjustInventoryDto =>
    ({
      type: 'ADJUSTMENT',
      newQuantityOnHand,
      expectedVersion,
      reason: 'Inventaire physique',
    }) as AdjustInventoryDto;

  it('delta stocké = after − before, version vérifiée SOUS verrou ligne', async () => {
    const { service, tx } = buildService();
    tx.$queryRaw.mockResolvedValue([{ quantityOnHand: 10, version: 3 }]);

    const result = await service.adjust(TENANT, 'shop-1', 'var-1', adjustment(4, 3), {});

    expect(result.movement).toMatchObject({
      type: 'ADJUSTMENT',
      quantityDelta: -6,
      quantityBefore: 10,
      quantityAfter: 4,
    });
    expect(tx.inventoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { quantityOnHand: 4, version: { increment: 1 } },
      }),
    );
  });

  it('version périmée → InventoryConcurrencyError (l’UI recharge et reconfirme)', async () => {
    const { service, tx } = buildService();
    tx.$queryRaw.mockResolvedValue([{ quantityOnHand: 12, version: 5 }]); // modifié entre-temps

    await expect(service.adjust(TENANT, 'shop-1', 'var-1', adjustment(4, 3), {})).rejects.toThrow(
      InventoryConcurrencyError,
    );
    expect(tx.inventoryItem.update).not.toHaveBeenCalled();
  });

  it('quantité inchangée → aucun mouvement (InvalidInventoryAdjustmentError)', async () => {
    const { service, tx } = buildService();
    tx.$queryRaw.mockResolvedValue([{ quantityOnHand: 10, version: 3 }]);

    await expect(service.adjust(TENANT, 'shop-1', 'var-1', adjustment(10, 3), {})).rejects.toThrow(
      InvalidInventoryAdjustmentError,
    );
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });
});
