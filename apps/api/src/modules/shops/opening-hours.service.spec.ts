import { InvalidOpeningHoursError, ShopArchivedError, ShopNotFoundError } from '@whauto/shared';

import { ROLE_PERMISSIONS } from '../../common/tenant/permissions';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import type { PrismaService } from '../../prisma/prisma.service';
import type { OrganizationAuditService } from '../organizations/organization-audit.service';
import { OpeningHoursService } from './opening-hours.service';

const TENANT: TenantContext = {
  userId: 'user-1',
  organizationId: 'org-1',
  membershipId: 'membership-1',
  role: 'MANAGER',
  permissions: ROLE_PERMISSIONS.MANAGER,
};

const MONDAY_PERIODS = [
  {
    dayOfWeek: 'MONDAY' as const,
    isClosed: false,
    periods: [
      { opensAt: '08:00', closesAt: '12:00' },
      { opensAt: '14:00', closesAt: '18:00' },
    ],
  },
];

function buildMocks() {
  const prisma = {
    shop: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'shop-1', status: 'ACTIVE', timezone: 'Africa/Douala' }),
    },
    shopOpeningHour: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma),
  );

  const auditService = {
    record: jest.fn().mockResolvedValue({}),
    recordSafe: jest.fn().mockResolvedValue(undefined),
  };

  const service = new OpeningHoursService(
    prisma as unknown as PrismaService,
    auditService as unknown as OrganizationAuditService,
  );
  return { service, prisma, auditService };
}

describe('OpeningHoursService', () => {
  it('get : Shop étrangère → 404 (filtre id + organizationId)', async () => {
    const { service, prisma } = buildMocks();
    prisma.shop.findFirst.mockResolvedValue(null);
    await expect(service.get(TENANT, 'foreign')).rejects.toThrow(ShopNotFoundError);
    expect(prisma.shop.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-1' }) }),
    );
  });

  it('replace : deleteMany + createMany + audit dans la même transaction', async () => {
    const { service, prisma, auditService } = buildMocks();

    await service.replace(TENANT, 'shop-1', MONDAY_PERIODS, {});

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.shopOpeningHour.deleteMany).toHaveBeenCalledWith({ where: { shopId: 'shop-1' } });
    expect(prisma.shopOpeningHour.createMany).toHaveBeenCalledWith({
      data: [
        { dayOfWeek: 'MONDAY', opensAtMinutes: 480, closesAtMinutes: 720, shopId: 'shop-1' },
        { dayOfWeek: 'MONDAY', opensAtMinutes: 840, closesAtMinutes: 1080, shopId: 'shop-1' },
      ],
    });
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'SHOP_OPENING_HOURS_UPDATED',
        metadata: { shopId: 'shop-1', openDays: 1, periods: 2 },
      }),
      prisma,
    );
  });

  it('replace : un échec d’audit annule le remplacement (même transaction)', async () => {
    const { service, prisma, auditService } = buildMocks();
    auditService.record.mockRejectedValue(new Error('audit down'));

    await expect(service.replace(TENANT, 'shop-1', MONDAY_PERIODS, {})).rejects.toThrow(
      'audit down',
    );
    expect(auditService.record).toHaveBeenCalledWith(expect.anything(), prisma);
  });

  it('replace : Shop archivée refusée avant toute écriture', async () => {
    const { service, prisma } = buildMocks();
    prisma.shop.findFirst.mockResolvedValue({
      id: 'shop-1',
      status: 'ARCHIVED',
      timezone: 'Africa/Douala',
    });

    await expect(service.replace(TENANT, 'shop-1', MONDAY_PERIODS, {})).rejects.toThrow(
      ShopArchivedError,
    );
    expect(prisma.shopOpeningHour.deleteMany).not.toHaveBeenCalled();
  });

  it('replace : horaires invalides refusés avant la transaction', async () => {
    const { service, prisma } = buildMocks();

    await expect(
      service.replace(
        TENANT,
        'shop-1',
        [{ dayOfWeek: 'MONDAY', isClosed: false, periods: [] }],
        {},
      ),
    ).rejects.toThrow(InvalidOpeningHoursError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('replace : tous les jours fermés = table vidée sans createMany', async () => {
    const { service, prisma } = buildMocks();

    await service.replace(TENANT, 'shop-1', [{ dayOfWeek: 'MONDAY', isClosed: true, periods: [] }], {});

    expect(prisma.shopOpeningHour.deleteMany).toHaveBeenCalled();
    expect(prisma.shopOpeningHour.createMany).not.toHaveBeenCalled();
  });
});
