import { apiRequest } from '@/lib/api/client';
import type { MembershipRole, Organization } from '@/features/organizations/api';

export type InvitationRole = 'ADMIN' | 'MANAGER' | 'AGENT';
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';

export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: InvitationRole;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
}

export interface MyInvitation extends Invitation {
  organization: { id: string; name: string; slug: string };
}

export interface PaginatedInvitations {
  items: Invitation[];
  total: number;
  page: number;
  limit: number;
}

export interface InvitationCreated {
  invitation: Invitation;
  resent: boolean;
  devLink?: string;
}

export const invitationsApi = {
  list(organizationId: string, params: { page?: number; limit?: number } = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return apiRequest<PaginatedInvitations>(`/organizations/${organizationId}/invitations${suffix}`);
  },
  create(organizationId: string, input: { email: string; role: InvitationRole }) {
    return apiRequest<InvitationCreated>(`/organizations/${organizationId}/invitations`, {
      method: 'POST',
      body: input,
    });
  },
  cancel(organizationId: string, invitationId: string) {
    return apiRequest<void>(`/organizations/${organizationId}/invitations/${invitationId}/cancel`, {
      method: 'POST',
    });
  },
  mine() {
    return apiRequest<MyInvitation[]>('/invitations/mine');
  },
  accept(token: string) {
    return apiRequest<{ organization: Organization; membershipId: string; role: MembershipRole }>(
      '/invitations/accept',
      { method: 'POST', body: { token } },
    );
  },
  decline(token: string) {
    return apiRequest<void>('/invitations/decline', { method: 'POST', body: { token } });
  },
};

export const invitationKeys = {
  all: (organizationId: string) => ['organizations', organizationId, 'invitations'] as const,
  list: (organizationId: string, page: number) =>
    [...invitationKeys.all(organizationId), 'list', page] as const,
  mine: () => ['invitations', 'mine'] as const,
};
