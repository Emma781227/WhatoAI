import { Prisma } from '@whauto/database';
import {
  OrganizationArchivedError,
  OrganizationSlugAlreadyUsedError,
  ValidationError,
} from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { ROLE_PERMISSIONS } from '../../common/tenant/permissions';
import type { PrismaService } from '../../prisma/prisma.service';
import type { OrganizationAuditService } from './organization-audit.service';
import { OrganizationsService } from './organizations.service';

const ORG = {
  id: 'org-1',
  name: 'Boutique Aïcha',
  slug: 'boutique-aicha',
  status: 'ACTIVE',
  timezone: 'Africa/Douala',
  defaultCurrency: 'XAF',
  defaultLocale: 'fr',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const OWNER_TENANT: TenantContext = {
  userId: 'user-1',
  organizationId: 'org-1',
  membershipId: 'membership-1',
  role: 'OWNER',
  permissions: ROLE_PERMISSIONS.OWNER,
};

function slugConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['slug'] },
  });
}

function buildMocks() {
  const prisma = {
    organization: {
      create: jest.fn().mockResolvedValue(ORG),
      update: jest.fn().mockResolvedValue(ORG),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(ORG),
      findUniqueOrThrow: jest.fn().mockResolvedValue(ORG),
    },
    membership: {
      create: jest.fn().mockResolvedValue({ id: 'membership-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(1),
    },
    wallet: {
      create: jest.fn().mockResolvedValue({ id: 'wallet-1' }),
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

  const service = new OrganizationsService(
    prisma as unknown as PrismaService,
    auditService as unknown as OrganizationAuditService,
  );
  return { service, prisma, auditService };
}

describe('OrganizationsService', () => {
  describe('create', () => {
    it('crée org + Membership OWNER + audit ORGANIZATION_CREATED dans une transaction', async () => {
      const { service, prisma, auditService } = buildMocks();

      const result = await service.create('user-1', { name: 'Boutique Aïcha' }, {});

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.organization.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Boutique Aïcha',
            slug: 'boutique-aicha',
            createdByUserId: 'user-1',
          }),
        }),
      );
      expect(prisma.membership.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { userId: 'user-1', organizationId: 'org-1', role: 'OWNER', status: 'ACTIVE' },
        }),
      );
      // Audit structurant : même client transactionnel (2e argument présent).
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ORGANIZATION_CREATED', actorUserId: 'user-1' }),
        prisma,
      );
      expect(result.role).toBe('OWNER');
      expect(result.membershipId).toBe('membership-1');
    });

    it('slug fourni invalide → ValidationError sans écriture', async () => {
      const { service, prisma } = buildMocks();
      await expect(
        service.create('user-1', { name: 'X Y', slug: 'Invalid Slug!' }, {}),
      ).rejects.toThrow(ValidationError);
      expect(prisma.organization.create).not.toHaveBeenCalled();
    });

    it('slug fourni en collision → 409 sans retry', async () => {
      const { service, prisma } = buildMocks();
      prisma.organization.create.mockRejectedValue(slugConflict());

      await expect(
        service.create('user-1', { name: 'Boutique', slug: 'boutique-aicha' }, {}),
      ).rejects.toThrow(OrganizationSlugAlreadyUsedError);
      expect(prisma.organization.create).toHaveBeenCalledTimes(1);
    });

    it('slug auto-généré en collision → retry avec suffixe', async () => {
      const { service, prisma } = buildMocks();
      prisma.organization.create.mockRejectedValueOnce(slugConflict()).mockResolvedValue(ORG);

      await service.create('user-1', { name: 'Boutique Aïcha' }, {});

      expect(prisma.organization.create).toHaveBeenCalledTimes(2);
      expect(prisma.organization.create.mock.calls[1][0].data.slug).toBe('boutique-aicha-2');
    });

    it('nom non translittérable en slug → ValidationError', async () => {
      const { service } = buildMocks();
      await expect(service.create('user-1', { name: '!!!' }, {})).rejects.toThrow(ValidationError);
    });
  });

  describe('listForUser', () => {
    it('ne liste que les Memberships ACTIVE de l’utilisateur', async () => {
      const { service, prisma } = buildMocks();
      await service.listForUser('user-1');
      expect(prisma.membership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', status: 'ACTIVE' } }),
      );
    });
  });

  describe('update', () => {
    it('aucun champ fourni → ValidationError', async () => {
      const { service } = buildMocks();
      await expect(service.update(OWNER_TENANT, {}, {})).rejects.toThrow(ValidationError);
    });

    it('collision de slug → 409', async () => {
      const { service, prisma } = buildMocks();
      prisma.organization.update.mockRejectedValue(slugConflict());
      await expect(service.update(OWNER_TENANT, { slug: 'pris' }, {})).rejects.toThrow(
        OrganizationSlugAlreadyUsedError,
      );
    });

    it('met à jour et audite (non bloquant)', async () => {
      const { service, prisma, auditService } = buildMocks();
      await service.update(OWNER_TENANT, { name: 'Nouveau nom', defaultCurrency: 'xaf' }, {});
      expect(prisma.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'org-1' },
          data: { name: 'Nouveau nom', defaultCurrency: 'XAF' },
        }),
      );
      expect(auditService.recordSafe).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ORGANIZATION_UPDATED' }),
      );
    });
  });

  describe('archive', () => {
    it('updateMany conditionnel (status=ACTIVE) + audit dans la transaction', async () => {
      const { service, prisma, auditService } = buildMocks();
      await service.archive(OWNER_TENANT, {});

      expect(prisma.organization.updateMany).toHaveBeenCalledWith({
        where: { id: 'org-1', status: 'ACTIVE' },
        data: { status: 'ARCHIVED' },
      });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ORGANIZATION_ARCHIVED' }),
        prisma,
      );
    });

    it('déjà archivée (count=0) → OrganizationArchivedError, pas d’audit', async () => {
      const { service, prisma, auditService } = buildMocks();
      prisma.organization.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.archive(OWNER_TENANT, {})).rejects.toThrow(OrganizationArchivedError);
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });
});
