import type { Prisma } from '@whauto/database';
import { CartInsufficientStockError, ReservationConcurrencyError } from '@whauto/shared';

import { ReservationService } from './reservation.service';

const CONFIG = { ttlMinutes: 15, maxLifetimeMinutes: 60, renewalMinIntervalSeconds: 60 };

function buildTx() {
  return {
    $queryRaw: jest.fn(),
    stockReservation: {
      create: jest.fn().mockResolvedValue({ id: 'res-1', expiresAt: new Date() }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    inventoryMovement: { create: jest.fn().mockResolvedValue({ id: 'mov-1' }) },
  } as unknown as Prisma.TransactionClient & {
    $queryRaw: jest.Mock;
    stockReservation: { create: jest.Mock; updateMany: jest.Mock };
    inventoryMovement: { create: jest.Mock };
  };
}

const BASE = {
  organizationId: 'org-1',
  shopId: 'shop-1',
  cartId: 'cart-1',
  cartItemId: 'item-1',
  variantId: 'var-1',
  quantity: 2,
  trackInventory: true,
  config: CONFIG,
};

describe('ReservationService.reserveForItem', () => {
  it('variante non suivie : aucune réservation, rien d’écrit', async () => {
    const tx = buildTx();
    const service = new ReservationService();
    const result = await service.reserveForItem(tx, { ...BASE, trackInventory: false });
    expect(result).toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.stockReservation.create).not.toHaveBeenCalled();
  });

  it('réservation atomique : UPDATE conditionnel puis ligne + mouvement RESERVATION', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([{ quantityOnHand: 10, quantityReserved: 5 }]);
    const service = new ReservationService();

    const result = await service.reserveForItem(tx, BASE);

    expect(result).not.toBeNull();
    expect(tx.stockReservation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ quantity: 2, cartItemId: 'item-1' }) }),
    );
    // Mouvement : onHand INCHANGÉ (delta 0, before=after), colonnes réservées exactes.
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'RESERVATION',
          quantityDelta: 0,
          quantityBefore: 10,
          quantityAfter: 10,
          quantityReservedBefore: 3,
          quantityReservedAfter: 5,
          referenceType: 'STOCK_RESERVATION',
        }),
      }),
    );
  });

  it('stock insuffisant : 0 ligne retournée → CartInsufficientStockError, RIEN d’écrit', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([]); // condition non satisfaite
    const service = new ReservationService();

    await expect(service.reserveForItem(tx, BASE)).rejects.toThrow(CartInsufficientStockError);
    expect(tx.stockReservation.create).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('maxExpiresAt figé à la création (durée cumulée plafonnée)', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([{ quantityOnHand: 10, quantityReserved: 2 }]);
    const service = new ReservationService();
    const before = Date.now();
    await service.reserveForItem(tx, BASE);
    const data = tx.stockReservation.create.mock.calls[0][0].data;
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 14 * 60_000);
    expect(data.maxExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 59 * 60_000);
  });
});

describe('ReservationService.adjustActiveReservation (validé §18)', () => {
  const RESERVATION = { id: 'res-1', variantId: 'var-1', organizationId: 'org-1', shopId: 'shop-1' };

  it('augmentation : réserve UNIQUEMENT la différence (mouvement RESERVATION)', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([{ quantityOnHand: 10, quantityReserved: 5 }]);
    const service = new ReservationService();

    await service.adjustActiveReservation(tx, RESERVATION, 3);

    expect(tx.stockReservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'res-1', status: 'ACTIVE' },
        data: { quantity: { increment: 3 } },
      }),
    );
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'RESERVATION' }) }),
    );
  });

  it('réduction : libère UNIQUEMENT la différence (mouvement RELEASE)', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([{ quantityOnHand: 10, quantityReserved: 3 }]);
    const service = new ReservationService();

    await service.adjustActiveReservation(tx, RESERVATION, -2);

    expect(tx.stockReservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { quantity: { increment: -2 } } }),
    );
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'RELEASE',
          quantityReservedBefore: 5,
          quantityReservedAfter: 3,
        }),
      }),
    );
  });

  it('réservation expirée concurremment (count=0) → ReservationConcurrencyError', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([{ quantityOnHand: 10, quantityReserved: 5 }]);
    tx.stockReservation.updateMany.mockResolvedValue({ count: 0 });
    const service = new ReservationService();

    await expect(service.adjustActiveReservation(tx, RESERVATION, 1)).rejects.toThrow(
      ReservationConcurrencyError,
    );
  });

  it('delta nul = no-op', async () => {
    const tx = buildTx();
    const service = new ReservationService();
    await service.adjustActiveReservation(tx, RESERVATION, 0);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('ReservationService.releaseReservation — IDEMPOTENTE', () => {
  const RESERVATION = {
    id: 'res-1',
    variantId: 'var-1',
    quantity: 2,
    organizationId: 'org-1',
    shopId: 'shop-1',
  };

  it('libère une réservation ACTIVE : transition + décrément + mouvement RELEASE', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([{ quantityOnHand: 10, quantityReserved: 3 }]);
    const service = new ReservationService();

    const applied = await service.releaseReservation(tx, RESERVATION, 'RELEASED');

    expect(applied).toBe(true);
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'RELEASE',
          quantityReservedBefore: 5,
          quantityReservedAfter: 3,
        }),
      }),
    );
  });

  it('DOUBLE release = no-op (count 0, aucun décrément, aucun mouvement)', async () => {
    const tx = buildTx();
    tx.stockReservation.updateMany.mockResolvedValue({ count: 0 }); // déjà libérée
    const service = new ReservationService();

    const applied = await service.releaseReservation(tx, RESERVATION, 'EXPIRED');

    expect(applied).toBe(false);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });
});

describe('ReservationService.renewIfDue — renouvellement contrôlé (validé §16)', () => {
  const service = new ReservationService();

  it('throttle : trop tôt depuis la dernière action → no-op', async () => {
    const tx = buildTx();
    const now = Date.now();
    const result = await service.renewIfDue(
      tx,
      {
        id: 'res-1',
        expiresAt: new Date(now + 10 * 60_000),
        maxExpiresAt: new Date(now + 50 * 60_000),
        lastRenewedAt: new Date(now - 10_000), // il y a 10 s < 60 s
        createdAt: new Date(now - 60_000),
      },
      CONFIG,
    );
    expect(result).toBeNull();
    expect(tx.stockReservation.updateMany).not.toHaveBeenCalled();
  });

  it('renouvelle jusqu’à min(now+TTL, maxExpiresAt) — jamais au-delà du plafond', async () => {
    const tx = buildTx();
    const now = Date.now();
    const maxExpiresAt = new Date(now + 5 * 60_000); // plafond dans 5 min < TTL 15 min
    const result = await service.renewIfDue(
      tx,
      {
        id: 'res-1',
        expiresAt: new Date(now + 2 * 60_000),
        maxExpiresAt,
        lastRenewedAt: new Date(now - 120_000),
        createdAt: new Date(now - 300_000),
      },
      CONFIG,
    );
    expect(result?.getTime()).toBe(maxExpiresAt.getTime());
  });

  it('plafond déjà atteint → no-op', async () => {
    const tx = buildTx();
    const now = Date.now();
    const cap = new Date(now + 60_000);
    const result = await service.renewIfDue(
      tx,
      {
        id: 'res-1',
        expiresAt: cap, // déjà au plafond
        maxExpiresAt: cap,
        lastRenewedAt: new Date(now - 120_000),
        createdAt: new Date(now - 300_000),
      },
      CONFIG,
    );
    expect(result).toBeNull();
  });
});
