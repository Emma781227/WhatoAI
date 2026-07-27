import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AmbiguousOrganizationSelectorError,
  OrganizationArchivedError,
  OrganizationNotFoundError,
  OrganizationSuspendedError,
} from '@whauto/shared';

import type { PrismaService } from '../../prisma/prisma.service';
import { ROLE_PERMISSIONS } from './permissions';
import type { RequestWithTenant } from './tenant-context.interface';
import { TenantGuard } from './tenant.guard';

interface ContextOptions {
  params?: Record<string, string>;
  headers?: Record<string, string | string[]>;
}

function contextFor(options: ContextOptions): {
  context: ExecutionContext;
  request: RequestWithTenant;
} {
  const request = {
    user: { userId: 'user-1', sessionId: 'session-1' },
    params: options.params ?? {},
    headers: options.headers ?? {},
  } as unknown as RequestWithTenant;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('TenantGuard', () => {
  const activeMembership = {
    id: 'membership-1',
    role: 'ADMIN' as const,
    status: 'ACTIVE' as const,
    organization: { status: 'ACTIVE' as const },
  };

  function buildGuard(membership: unknown, allowArchived = false) {
    const findUnique = jest.fn().mockResolvedValue(membership);
    const prisma = { membership: { findUnique } } as unknown as PrismaService;
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(allowArchived),
    } as unknown as Reflector;
    return { guard: new TenantGuard(prisma, reflector), findUnique };
  }

  it('membre ACTIVE : construit le TenantContext depuis le Membership vérifié en base', async () => {
    const { guard, findUnique } = buildGuard(activeMembership);
    const { context, request } = contextFor({ params: { organizationId: 'org-1' } });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_organizationId: { userId: 'user-1', organizationId: 'org-1' } },
      }),
    );
    expect(request.tenant).toEqual({
      userId: 'user-1',
      organizationId: 'org-1',
      membershipId: 'membership-1',
      role: 'ADMIN',
      permissions: ROLE_PERMISSIONS.ADMIN,
    });
  });

  it('non-membre : 404 ORGANIZATION_NOT_FOUND (anti-énumération, jamais 403)', async () => {
    const { guard } = buildGuard(null);
    const { context } = contextFor({ params: { organizationId: 'org-other' } });
    await expect(guard.canActivate(context)).rejects.toThrow(OrganizationNotFoundError);
  });

  it.each(['LEFT', 'SUSPENDED'] as const)('membership %s : accès refusé en 404', async (status) => {
    const { guard } = buildGuard({ ...activeMembership, status });
    const { context } = contextFor({ params: { organizationId: 'org-1' } });
    await expect(guard.canActivate(context)).rejects.toThrow(OrganizationNotFoundError);
  });

  it('organisation SUSPENDED : bloquée même pour un membre actif', async () => {
    const { guard } = buildGuard({ ...activeMembership, organization: { status: 'SUSPENDED' } });
    const { context } = contextFor({ params: { organizationId: 'org-1' } });
    await expect(guard.canActivate(context)).rejects.toThrow(OrganizationSuspendedError);
  });

  it('organisation ARCHIVED : bloquée par défaut, autorisée avec @AllowArchived', async () => {
    const archived = { ...activeMembership, organization: { status: 'ARCHIVED' } };

    const blocked = buildGuard(archived, false);
    const blockedContext = contextFor({ params: { organizationId: 'org-1' } });
    await expect(blocked.guard.canActivate(blockedContext.context)).rejects.toThrow(
      OrganizationArchivedError,
    );

    const allowed = buildGuard(archived, true);
    const allowedContext = contextFor({ params: { organizationId: 'org-1' } });
    await expect(allowed.guard.canActivate(allowedContext.context)).resolves.toBe(true);
  });

  it('résout l’organisation depuis le header X-Organization-Id en l’absence de path param', async () => {
    const { guard, findUnique } = buildGuard(activeMembership);
    const { context } = contextFor({ headers: { 'x-organization-id': 'org-1' } });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_organizationId: { userId: 'user-1', organizationId: 'org-1' } },
      }),
    );
  });

  it('path et header présents mais différents : 400, jamais de choix silencieux', async () => {
    const { guard, findUnique } = buildGuard(activeMembership);
    const { context } = contextFor({
      params: { organizationId: 'org-1' },
      headers: { 'x-organization-id': 'org-2' },
    });
    await expect(guard.canActivate(context)).rejects.toThrow(AmbiguousOrganizationSelectorError);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('path et header identiques : accepté', async () => {
    const { guard } = buildGuard(activeMembership);
    const { context } = contextFor({
      params: { organizationId: 'org-1' },
      headers: { 'x-organization-id': 'org-1' },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('aucun identifiant : 404', async () => {
    const { guard } = buildGuard(activeMembership);
    const { context } = contextFor({});
    await expect(guard.canActivate(context)).rejects.toThrow(OrganizationNotFoundError);
  });
});
