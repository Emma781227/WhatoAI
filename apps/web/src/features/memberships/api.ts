import { apiRequest } from '@/lib/api/client';
import type { MembershipRole } from '@/features/organizations/api';

export type MembershipStatus = 'ACTIVE' | 'SUSPENDED' | 'LEFT';

export interface Member {
  membershipId: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  role: MembershipRole;
  status: MembershipStatus;
  joinedAt: string;
}

export interface PaginatedMembers {
  items: Member[];
  total: number;
  page: number;
  limit: number;
}

export const membershipsApi = {
  list(organizationId: string, params: { page?: number; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return apiRequest<PaginatedMembers>(`/organizations/${organizationId}/members${suffix}`);
  },
  updateRole(organizationId: string, membershipId: string, role: Exclude<MembershipRole, 'OWNER'>) {
    return apiRequest<Member>(`/organizations/${organizationId}/members/${membershipId}/role`, {
      method: 'PATCH',
      body: { role },
    });
  },
  remove(organizationId: string, membershipId: string) {
    return apiRequest<void>(`/organizations/${organizationId}/members/${membershipId}`, {
      method: 'DELETE',
    });
  },
  leave(organizationId: string) {
    return apiRequest<void>(`/organizations/${organizationId}/leave`, { method: 'POST' });
  },
};

export const memberKeys = {
  all: (organizationId: string) => ['organizations', organizationId, 'members'] as const,
  list: (organizationId: string, page: number) =>
    [...memberKeys.all(organizationId), 'list', page] as const,
};
