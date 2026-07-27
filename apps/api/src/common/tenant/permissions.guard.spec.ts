import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { InsufficientPermissionError } from '@whauto/shared';

import { PERMISSIONS, ROLE_PERMISSIONS } from './permissions';
import type { Permission } from './permissions';
import { PermissionsGuard } from './permissions.guard';

function contextWithTenant(permissions: readonly Permission[]): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ tenant: { permissions } }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function guardRequiring(required: Permission[] | undefined): PermissionsGuard {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(required),
  } as unknown as Reflector;
  return new PermissionsGuard(reflector);
}

describe('PermissionsGuard', () => {
  it('laisse passer une route sans @RequirePermissions', () => {
    expect(guardRequiring(undefined).canActivate(contextWithTenant([]))).toBe(true);
  });

  it('accepte quand toutes les permissions requises sont présentes', () => {
    const guard = guardRequiring([PERMISSIONS.MEMBERS_READ, PERMISSIONS.MEMBERS_INVITE]);
    expect(guard.canActivate(contextWithTenant(ROLE_PERMISSIONS.ADMIN))).toBe(true);
  });

  it('rejette dès qu’une permission manque (AGENT sans members.read)', () => {
    const guard = guardRequiring([PERMISSIONS.MEMBERS_READ]);
    expect(() => guard.canActivate(contextWithTenant(ROLE_PERMISSIONS.AGENT))).toThrow(
      InsufficientPermissionError,
    );
  });

  it('rejette un MANAGER sur une route members.invite', () => {
    const guard = guardRequiring([PERMISSIONS.MEMBERS_INVITE]);
    expect(() => guard.canActivate(contextWithTenant(ROLE_PERMISSIONS.MANAGER))).toThrow(
      InsufficientPermissionError,
    );
  });
});
