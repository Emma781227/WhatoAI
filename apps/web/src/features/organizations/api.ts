import { apiRequest } from '@/lib/api/client';
import type { Permission } from '@/lib/permissions/constants';

export type OrganizationStatus = 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
export type MembershipRole = 'OWNER' | 'ADMIN' | 'MANAGER' | 'AGENT';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  timezone: string;
  defaultCurrency: string;
  defaultLocale: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMembership {
  organization: Organization;
  membershipId: string;
  role: MembershipRole;
  joinedAt: string;
}

export interface OrganizationDetail extends Organization {
  role: MembershipRole;
  permissions: Permission[];
  memberCount: number;
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  timezone?: string;
  defaultCurrency?: string;
  defaultLocale?: string;
}

export const organizationsApi = {
  list() {
    return apiRequest<OrganizationMembership[]>('/organizations');
  },
  get(organizationId: string) {
    return apiRequest<OrganizationDetail>(`/organizations/${organizationId}`);
  },
  create(input: CreateOrganizationInput) {
    return apiRequest<{ organization: Organization; membershipId: string; role: MembershipRole }>(
      '/organizations',
      { method: 'POST', body: input },
    );
  },
  update(organizationId: string, input: Partial<CreateOrganizationInput>) {
    return apiRequest<Organization>(`/organizations/${organizationId}`, {
      method: 'PATCH',
      body: input,
    });
  },
};

export const organizationKeys = {
  all: ['organizations'] as const,
  list: () => [...organizationKeys.all, 'list'] as const,
  detail: (organizationId: string) => [...organizationKeys.all, 'detail', organizationId] as const,
};
