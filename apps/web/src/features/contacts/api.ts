import { apiRequest } from '@/lib/api/client';

export type ContactStatus = 'ACTIVE' | 'BLOCKED' | 'ARCHIVED';

export interface Contact {
  id: string;
  organizationId: string;
  shopId: string;
  externalId: string | null;
  whatsappPhone: string;
  normalizedPhone: string;
  displayName: string | null;
  profilePictureUrl: string | null;
  email: string | null;
  language: string | null;
  city: string | null;
  countryCode: string | null;
  notes: string | null;
  status: ContactStatus;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedContacts {
  items: Contact[];
  total: number;
  page: number;
  limit: number;
}

export interface ListContactsParams {
  page?: number;
  limit?: number;
  shopId?: string;
  search?: string;
  status?: ContactStatus;
}

/** Convention backend : undefined = inchangé, null = effacement. */
export type UpdateContactInput = Partial<{
  displayName: string | null;
  email: string | null;
  language: string | null;
  city: string | null;
  countryCode: string | null;
  notes: string | null;
}>;

function contactsBase(organizationId: string): string {
  return `/organizations/${organizationId}/contacts`;
}

export const contactsApi = {
  list(organizationId: string, params: ListContactsParams = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.shopId) query.set('shopId', params.shopId);
    if (params.search) query.set('search', params.search);
    if (params.status) query.set('status', params.status);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return apiRequest<PaginatedContacts>(`${contactsBase(organizationId)}${suffix}`);
  },
  get(organizationId: string, contactId: string) {
    return apiRequest<Contact>(`${contactsBase(organizationId)}/${contactId}`);
  },
  update(organizationId: string, contactId: string, input: UpdateContactInput) {
    return apiRequest<Contact>(`${contactsBase(organizationId)}/${contactId}`, {
      method: 'PATCH',
      body: input,
    });
  },
};

export const contactKeys = {
  all: (organizationId: string) => ['organizations', organizationId, 'contacts'] as const,
  list: (organizationId: string, params: ListContactsParams) =>
    [...contactKeys.all(organizationId), 'list', params] as const,
  detail: (organizationId: string, contactId: string) =>
    [...contactKeys.all(organizationId), 'detail', contactId] as const,
};
