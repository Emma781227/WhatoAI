import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InsufficientPermissionError } from '@whauto/shared';

import type { Permission } from './permissions';
import { REQUIRED_PERMISSIONS_KEY } from './require-permissions.decorator';
import type { RequestWithTenant } from './tenant-context.interface';

/**
 * Vérifie les permissions déclarées via @RequirePermissions contre le
 * TenantContext. À poser APRÈS TenantGuard. Toutes les permissions listées
 * sont requises. Sans décorateur, la route ne demande que l'appartenance
 * (déjà garantie par TenantGuard).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) {
      return true;
    }

    const { tenant } = context.switchToHttp().getRequest<RequestWithTenant>();
    const missing = required.some((permission) => !tenant.permissions.includes(permission));
    if (missing) {
      throw new InsufficientPermissionError();
    }
    return true;
  }
}
