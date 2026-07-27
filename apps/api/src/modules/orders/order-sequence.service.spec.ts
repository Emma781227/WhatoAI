import type { Prisma } from '@whauto/database';
import { OrderNumberGenerationError } from '@whauto/shared';

import { OrderSequenceService } from './order-sequence.service';

function buildTx() {
  return {
    shop: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  } as unknown as Prisma.TransactionClient & {
    shop: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    $queryRaw: jest.Mock;
    $executeRaw: jest.Mock;
  };
}

describe('OrderSequenceService.ensurePrefix — préfixe STABLE (validé — ajustement 1)', () => {
  it('renvoie le préfixe déjà stocké sans écrire (stabilité après changement de slug)', async () => {
    const tx = buildTx();
    const service = new OrderSequenceService();
    const prefix = await service.ensurePrefix(tx, {
      id: 'shop-1',
      organizationId: 'org-1',
      slug: 'nouveau-slug-different',
      orderNumberPrefix: 'FASHION',
    });
    expect(prefix).toBe('FASHION');
    expect(tx.shop.updateMany).not.toHaveBeenCalled();
  });

  it('génère et persiste le candidat dérivé du slug si absent', async () => {
    const tx = buildTx();
    tx.shop.updateMany.mockResolvedValue({ count: 1 });
    const service = new OrderSequenceService();
    const prefix = await service.ensurePrefix(tx, {
      id: 'shop-1',
      organizationId: 'org-1',
      slug: 'fashion-store',
      orderNumberPrefix: null,
    });
    expect(prefix).toBe('FASHIONS');
    expect(tx.shop.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { orderNumberPrefix: 'FASHIONS' } }),
    );
  });

  it('deux Shops au même candidat tronqué : la seconde reçoit un suffixe numérique', async () => {
    const tx = buildTx();
    // Collision de l'index CI par organisation (P2002) sur le premier essai,
    // puis succès sur le candidat suffixé.
    const { Prisma: PrismaRuntime } = jest.requireActual('@whauto/database');
    const collision = new PrismaRuntime.PrismaClientKnownRequestError('unique violation', {
      code: 'P2002',
      clientVersion: '6.19.3',
      meta: { target: ['organizationId'] },
    });
    tx.shop.updateMany
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce({ count: 1 });
    const service = new OrderSequenceService();
    const prefix = await service.ensurePrefix(tx, {
      id: 'shop-2',
      organizationId: 'org-1',
      slug: 'fashionland-bis',
      orderNumberPrefix: null,
    });
    expect(prefix).toBe('FASHIONL2');
    // SAVEPOINT indispensable : une violation P2002 avorte toute la
    // transaction PostgreSQL — sans ROLLBACK TO SAVEPOINT, la requête
    // suivante échouerait avec "current transaction is aborted" (validé —
    // bug réel corrigé après un 500 constaté en e2e). Essai 1 : SAVEPOINT +
    // ROLLBACK TO (échec) ; essai 2 : SAVEPOINT + RELEASE (succès) = 4 appels.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(4);
  });

  it('course concurrente : updateMany count=0 relit le préfixe posé entre-temps', async () => {
    const tx = buildTx();
    tx.shop.updateMany.mockResolvedValue({ count: 0 });
    tx.shop.findUniqueOrThrow.mockResolvedValue({ orderNumberPrefix: 'WON-BY-OTHER' });
    const service = new OrderSequenceService();
    const prefix = await service.ensurePrefix(tx, {
      id: 'shop-1',
      organizationId: 'org-1',
      slug: 'shop',
      orderNumberPrefix: null,
    });
    expect(prefix).toBe('WON-BY-OTHER');
  });
});

describe('OrderSequenceService.nextOrderNumber — UPSERT atomique (Shop, année)', () => {
  it('formate PREFIX-YYYY-NNNNNN depuis lastValue retourné', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([{ lastValue: 42 }]);
    const service = new OrderSequenceService();
    const number = await service.nextOrderNumber(tx, {
      shopId: 'shop-1',
      organizationId: 'org-1',
      prefix: 'FASHION',
      now: new Date('2026-07-20T00:00:00Z'),
    });
    expect(number).toBe('FASHION-2026-000042');
  });

  it('lastValue absent ou invalide → OrderNumberGenerationError', async () => {
    const tx = buildTx();
    tx.$queryRaw.mockResolvedValue([]);
    const service = new OrderSequenceService();
    await expect(
      service.nextOrderNumber(tx, { shopId: 's', organizationId: 'o', prefix: 'X' }),
    ).rejects.toThrow(OrderNumberGenerationError);
  });
});
