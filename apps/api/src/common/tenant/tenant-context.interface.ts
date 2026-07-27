import type { MembershipRole } from '@whauto/database';

import type { RequestWithUser } from '../../modules/auth/jwt-auth.guard';
import type { Permission } from './permissions';

/**
 * Contexte tenant construit par TenantGuard APRÈS vérification du Membership
 * en base. Aucune de ces valeurs ne provient directement du client.
 */
export interface TenantContext {
  userId: string;
  organizationId: string;
  membershipId: string;
  role: MembershipRole;
  permissions: readonly Permission[];
}

export interface RequestWithTenant extends RequestWithUser {
  tenant: TenantContext;
}
