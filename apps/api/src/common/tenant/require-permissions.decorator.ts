import { SetMetadata } from '@nestjs/common';

import type { Permission } from './permissions';

export const REQUIRED_PERMISSIONS_KEY = 'tenant:requiredPermissions';

/** Déclare les permissions exigées par PermissionsGuard (toutes requises). */
export const RequirePermissions = (
  ...permissions: Permission[]
): MethodDecorator & ClassDecorator => SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
