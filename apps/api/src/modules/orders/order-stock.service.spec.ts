import type { Prisma } from '@whauto/database';
import { OrderStockConsumptionError, OrderStockRestorationError } from '@whauto/shared';

import { OrderStockService } from './order-stock.service';

function buildTx() {
  return {
    $queryRaw: jest.fn(),
    inventoryMovement: { create: jest.fn().mockResolvedValue({ id: 'mov-1' }) },
  } as unknown as Prisma.TransactionClient & {
    $queryRaw: jest.Mock;
    inventoryMovement: { create: jest.Mock };
  };
}

describe('OrderStockService.consume — backorder-aware (validé — ajustement 11)', () => {
  it('stock suffisant : tout consommé depuis onHand, aucun backorder', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([
      { beforeOnHand: 10, beforeReserved: 3, quantityOnHand: 8, quantityReserved: 1 },
    ]);
    const service = new OrderStockService();
    const result = await service.consume(tx, { variantId: 'v1', quantity: 2 });
    expect(result.consumedFromStock).toBe(2);
    expect(result.backordered).toBe(0);
  });

  it('stock partiel : onHand JAMAIS négatif, le surplus devient backorder', async () => {
    const tx = buildTx();
    // Commande de 5, seulement 2 en stock (LEAST côté SQL) : onHand 2→0, reserved 5→0.
    tx.$queryRaw.mockResolvedValue([
      { beforeOnHand: 2, beforeReserved: 5, quantityOnHand: 0, quantityReserved: 0 },
    ]);
    const service = new OrderStockService();
    const result = await service.consume(tx, { variantId: 'v1', quantity: 5 });
    expect(result.consumedFromStock).toBe(2);
    expect(result.backordered).toBe(3);
    expect(result.counters.afterOnHand).toBeGreaterThanOrEqual(0);
  });

  it('backorder intégral (onHand = 0 déjà) : tout en attente, onHand inchangé à 0', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([
      { beforeOnHand: 0, beforeReserved: 4, quantityOnHand: 0, quantityReserved: 0 },
    ]);
    const service = new OrderStockService();
    const result = await service.consume(tx, { variantId: 'v1', quantity: 4 });
    expect(result.consumedFromStock).toBe(0);
    expect(result.backordered).toBe(4);
  });

  it('réservation incohérente (0 ligne) → OrderStockConsumptionError, rien capturé', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([]);
    const service = new OrderStockService();
    await expect(service.consume(tx, { variantId: 'v1', quantity: 2 })).rejects.toThrow(
      OrderStockConsumptionError,
    );
  });
});

describe('OrderStockService.restore — restitution (validé D9 + ajustement 9)', () => {
  it('réaugmente onHand de la quantité demandée', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([
      { beforeOnHand: 5, beforeReserved: 0, quantityOnHand: 7, quantityReserved: 0 },
    ]);
    const service = new OrderStockService();
    const counters = await service.restore(tx, { variantId: 'v1', quantity: 2 });
    expect(counters.afterOnHand).toBe(7);
  });

  it('InventoryItem absent (0 ligne) → OrderStockRestorationError — JAMAIS silencieux', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([]);
    const service = new OrderStockService();
    await expect(service.restore(tx, { variantId: 'missing', quantity: 2 })).rejects.toThrow(
      OrderStockRestorationError,
    );
  });
});

describe('OrderStockService — mouvements SALE / CANCELLATION', () => {
  it('SALE : delta = quantité réellement sortie (peut être < quantity commandée)', async () => {
    const tx = buildTx();
    const service = new OrderStockService();
    await service.recordSale(tx, {
      organizationId: 'org-1',
      shopId: 'shop-1',
      variantId: 'v1',
      orderId: 'order-1',
      counters: { beforeOnHand: 2, beforeReserved: 5, afterOnHand: 0, afterReserved: 0 },
      consumedFromStock: 2,
      actorUserId: null,
    });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'SALE',
          quantityDelta: -2,
          referenceType: 'ORDER',
          referenceId: 'order-1',
        }),
      }),
    );
  });

  it('CANCELLATION : delta POSITIF = stock restitué', async () => {
    const tx = buildTx();
    const service = new OrderStockService();
    await service.recordCancellation(tx, {
      organizationId: 'org-1',
      shopId: 'shop-1',
      variantId: 'v1',
      orderId: 'order-1',
      counters: { beforeOnHand: 0, beforeReserved: 0, afterOnHand: 3, afterReserved: 0 },
      restored: 3,
      actorUserId: null,
    });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'CANCELLATION', quantityDelta: 3 }),
      }),
    );
  });
});
