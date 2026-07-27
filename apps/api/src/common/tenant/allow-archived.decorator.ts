import { SetMetadata } from '@nestjs/common';

export const ALLOW_ARCHIVED_KEY = 'tenant:allowArchived';

/**
 * Autorise la route sur une organisation ARCHIVED (lecture seule uniquement —
 * ex. GET /organizations/:organizationId). Par défaut, TenantGuard bloque
 * toute route tenant-scopée d'une organisation archivée ou suspendue.
 */
export const AllowArchived = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_ARCHIVED_KEY, true);
