import {
  CannotLeaveAsOwnerError,
  CannotRemoveOwnerError,
  InvalidRoleTransitionError,
  MembershipNotFoundError,
} from '@whauto/shared';

import { ROLE_PERMISSIONS } from '../../common/tenant/permissions';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import { MembershipsService } from './memberships.service';
import type { OrganizationAuditService } from './organization-audit.service';

function tenantWithRole(role: TenantContext['role'], userId = `${role.toLowerCase()}-1`): TenantContext {
  return {
    userId,
    organizationId: 'org-1',
    membershipId: `membership-${userId}`,
    role,
    permissions: ROLE_PERMISSIONS[role],
  };
}

function member(role: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'membership-target',
    role,
    status: 'ACTIVE',
    joinedAt: new Date(),
    userId: 'target-user',
    user: { firstName: 'Fatou', lastName: 'Ndiaye', email: 'fatou@boutique.cm' },
    ...overrides,
  };
}

function buildMocks() {
  const prisma = {
    membership: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(member('MANAGER')),
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

  const realtime = {
    emitToOrganization: jest.fn(),
    evictUserFromOrganization: jest.fn().mockResolvedValue(undefined),
  };

  const service = new MembershipsService(
    prisma as unknown as PrismaService,
    auditService as unknown as OrganizationAuditService,
    realtime as unknown as RealtimeService,
  );
  return { service, prisma, auditService, realtime };
}

describe('MembershipsService', () => {
  describe('list', () => {
    it('filtre organizationId + status ACTIVE (LEFT invisible)', async () => {
      const { service, prisma } = buildMocks();
      await service.list(tenantWithRole('OWNER'), { page: 1, limit: 20, skip: 0 } as never);
      expect(prisma.membership.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: 'org-1', status: 'ACTIVE' } }),
      );
    });
  });

  describe('updateRole', () => {
    it('membre introuvable ou d’une autre organisation → 404', async () => {
      const { service, prisma } = buildMocks();
      prisma.membership.findFirst.mockResolvedValue(null);
      await expect(
        service.updateRole(tenantWithRole('OWNER'), 'other-tenant-membership', 'AGENT', {}),
      ).rejects.toThrow(MembershipNotFoundError);
      // Le filtre inclut l'organizationId du tenant.
      expect(prisma.membership.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org-1' }) }),
      );
    });

    it('impossible de modifier son propre rôle', async () => {
      const { service, prisma } = buildMocks();
      const tenant = tenantWithRole('OWNER', 'owner-1');
      prisma.membership.findFirst.mockResolvedValue(member('ADMIN', { userId: 'owner-1' }));
      await expect(service.updateRole(tenant, 'membership-target', 'AGENT', {})).rejects.toThrow(
        InvalidRoleTransitionError,
      );
    });

    it('OWNER intouchable via cette route', async () => {
      const { service, prisma } = buildMocks();
      prisma.membership.findFirst.mockResolvedValue(member('OWNER'));
      await expect(
        service.updateRole(tenantWithRole('OWNER'), 'membership-target', 'AGENT', {}),
      ).rejects.toThrow(InvalidRoleTransitionError);
    });

    it('un ADMIN ne modifie pas un autre ADMIN', async () => {
      const { service, prisma } = buildMocks();
      prisma.membership.findFirst.mockResolvedValue(member('ADMIN'));
      await expect(
        service.updateRole(tenantWithRole('ADMIN'), 'membership-target', 'AGENT', {}),
      ).rejects.toThrow(InvalidRoleTransitionError);
    });

    it('un ADMIN ne promeut pas au rang ADMIN (assignation strictement inférieure)', async () => {
      const { service, prisma } = buildMocks();
      prisma.membership.findFirst.mockResolvedValue(member('AGENT'));
      await expect(
        service.updateRole(tenantWithRole('ADMIN'), 'membership-target', 'ADMIN', {}),
      ).rejects.toThrow(InvalidRoleTransitionError);
    });

    it('succès : updateMany conditionnel sur le rôle lu + audit MEMBER_ROLE_CHANGED en transaction', async () => {
      const { service, prisma, auditService } = buildMocks();
      prisma.membership.findFirst.mockResolvedValue(member('AGENT'));

      await service.updateRole(tenantWithRole('OWNER'), 'membership-target', 'MANAGER', {});

      expect(prisma.membership.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'membership-target',
          organizationId: 'org-1',
          status: 'ACTIVE',
          role: 'AGENT',
        },
        data: { role: 'MANAGER' },
      });
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'MEMBER_ROLE_CHANGED',
          targetUserId: 'target-user',
          metadata: { from: 'AGENT', to: 'MANAGER' },
        }),
        prisma,
      );
    });

    it('rôle identique : no-op sans écriture', async () => {
      const { service, prisma } = buildMocks();
      prisma.membership.findFirst.mockResolvedValue(member('MANAGER'));
      await service.updateRole(tenantWithRole('OWNER'), 'membership-target', 'MANAGER', {});
      expect(prisma.membership.updateMany).not.toHaveBeenCalled();
    });

    it('modification concurrente (count=0) → 404 propre', async () => {
      const { service, prisma } = buildMocks();
      prisma.membership.findFirst.mockResolvedValue(member('AGENT'));
      prisma.membership.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.updateRole(tenantWithRole('OWNER'), 'membership-target', 'MANAGER', {}),
      ).rejects.toThrow(MembershipNotFoundError);
    });
  });

  describe('remove', () => {
    it('OWNER non retirable', async () => {
      const { service, prisma } = buildMocks();
      prisma.membership.findFirst.mockResolvedValue(member('OWNER'));
      await expect(
        service.remove(tenantWithRole('OWNER'), 'membership-target', {}),
      ).rejects.toThrow(CannotRemoveOwnerError);
    });

    it('un ADMIN ne retire pas un autre ADMIN', async () => {
      const { service, prisma } = buildMocks();
      prisma.membership.findFirst.mockResolvedValue(member('ADMIN'));
      await expect(
        service.remove(tenantWithRole('ADMIN'), 'membership-target', {}),
      ).rejects.toThrow(InvalidRoleTransitionError);
    });

    it('se retirer soi-même : renvoyé vers leave', async () => {
      const { service, prisma } = buildMocks();
      const tenant = tenantWithRole('ADMIN', 'admin-1');
      prisma.membership.findFirst.mockResolvedValue(member('AGENT', { userId: 'admin-1' }));
      await expect(service.remove(tenant, 'membership-target', {})).rejects.toThrow(
        InvalidRoleTransitionError,
      );
    });

    it('succès : passe en LEFT (conservé) + audit MEMBER_REMOVED en transaction', async () => {
      const { service, prisma, auditService } = buildMocks();
      prisma.membership.findFirst.mockResolvedValue(member('AGENT'));

      await service.remove(tenantWithRole('ADMIN'), 'membership-target', {});

      expect(prisma.membership.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'membership-target',
            organizationId: 'org-1',
            status: 'ACTIVE',
            role: { not: 'OWNER' },
          }),
          data: { status: 'LEFT' },
        }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'MEMBER_REMOVED', targetUserId: 'target-user' }),
        prisma,
      );
    });
  });

  describe('leave', () => {
    it('un OWNER ne peut pas quitter', async () => {
      const { service, prisma } = buildMocks();
      await expect(service.leave(tenantWithRole('OWNER'), {})).rejects.toThrow(
        CannotLeaveAsOwnerError,
      );
      expect(prisma.membership.updateMany).not.toHaveBeenCalled();
    });

    it('un membre quitte : LEFT + audit MEMBER_LEFT en transaction', async () => {
      const { service, prisma, auditService } = buildMocks();
      const tenant = tenantWithRole('AGENT');

      await service.leave(tenant, {});

      expect(prisma.membership.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: tenant.membershipId, status: 'ACTIVE' }),
          data: { status: 'LEFT' },
        }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'MEMBER_LEFT' }),
        prisma,
      );
    });
  });
});
