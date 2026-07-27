'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { organizationKeys, organizationsApi } from '@/features/organizations/api';
import { useOrganization } from '@/features/organizations/organization-provider';
import type { Permission } from './constants';

/**
 * Permissions effectives retournées par GET /organizations/:id — jamais une
 * matrice recopiée. Usage : adaptation de l'interface uniquement, la sécurité
 * reste entièrement backend.
 */
export function usePermissions() {
  const { activeOrganization } = useOrganization();
  const organizationId = activeOrganization.organization.id;

  const detailQuery = useQuery({
    queryKey: organizationKeys.detail(organizationId),
    queryFn: () => organizationsApi.get(organizationId),
    staleTime: 60_000,
  });

  const permissions = detailQuery.data?.permissions ?? [];
  return {
    isLoading: detailQuery.isPending,
    role: detailQuery.data?.role ?? activeOrganization.role,
    permissions,
    can: (permission: Permission) => permissions.includes(permission),
  };
}

/** Rend ses enfants uniquement si la permission est présente (masquage UI). */
export function Can({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = usePermissions();
  if (!can(permission)) {
    return null;
  }
  return <>{children}</>;
}
