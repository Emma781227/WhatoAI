import { apiRequest } from '@/lib/api/client';

export type ShopStatus = 'DRAFT' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
export type BusinessType =
  | 'RETAIL'
  | 'FASHION'
  | 'BEAUTY'
  | 'FOOD'
  | 'RESTAURANT'
  | 'ELECTRONICS'
  | 'SERVICES'
  | 'HEALTH'
  | 'EDUCATION'
  | 'TRAVEL'
  | 'OTHER';
export type DayOfWeek =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY';

export interface Shop {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  status: ShopStatus;
  isPrimary: boolean;
  businessType: BusinessType | null;
  logoUrl: string | null;
  coverUrl: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  countryCode: string;
  timezone: string;
  currency: string;
  locale: string;
  returnPolicy: string | null;
  deliveryPolicy: string | null;
  orderInstructions: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface PaginatedShops {
  items: Shop[];
  total: number;
  page: number;
  limit: number;
}

export interface ListShopsParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: ShopStatus;
  includeArchived?: boolean;
}

export interface OpeningHourPeriod {
  opensAt: string;
  closesAt: string;
}

export interface OpeningHourDay {
  dayOfWeek: DayOfWeek;
  isClosed: boolean;
  periods: OpeningHourPeriod[];
}

export interface OpeningHoursResponse {
  timezone: string;
  days: OpeningHourDay[];
}

export interface CreateShopInput {
  name: string;
  slug?: string;
  description?: string;
  businessType?: BusinessType;
  countryCode: string;
  timezone?: string;
  currency?: string;
  locale?: string;
}

/** Convention backend : undefined = inchangé, null = effacement. */
export type UpdateShopInput = Partial<{
  name: string;
  slug: string;
  description: string | null;
  businessType: BusinessType | null;
  logoUrl: string | null;
  coverUrl: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
  timezone: string;
  currency: string;
  locale: string;
  returnPolicy: string | null;
  deliveryPolicy: string | null;
  orderInstructions: string | null;
}>;

function shopsBase(organizationId: string): string {
  return `/organizations/${organizationId}/shops`;
}

export const shopsApi = {
  list(organizationId: string, params: ListShopsParams = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.search) query.set('search', params.search);
    if (params.status) query.set('status', params.status);
    if (params.includeArchived) query.set('includeArchived', 'true');
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return apiRequest<PaginatedShops>(`${shopsBase(organizationId)}${suffix}`);
  },
  get(organizationId: string, shopId: string) {
    return apiRequest<Shop>(`${shopsBase(organizationId)}/${shopId}`);
  },
  create(organizationId: string, input: CreateShopInput) {
    return apiRequest<Shop>(shopsBase(organizationId), { method: 'POST', body: input });
  },
  update(organizationId: string, shopId: string, input: UpdateShopInput) {
    return apiRequest<Shop>(`${shopsBase(organizationId)}/${shopId}`, {
      method: 'PATCH',
      body: input,
    });
  },
  activate(organizationId: string, shopId: string) {
    return apiRequest<Shop>(`${shopsBase(organizationId)}/${shopId}/activate`, { method: 'POST' });
  },
  deactivate(organizationId: string, shopId: string) {
    return apiRequest<Shop>(`${shopsBase(organizationId)}/${shopId}/deactivate`, { method: 'POST' });
  },
  setPrimary(organizationId: string, shopId: string) {
    return apiRequest<Shop>(`${shopsBase(organizationId)}/${shopId}/set-primary`, { method: 'POST' });
  },
  archive(organizationId: string, shopId: string) {
    return apiRequest<Shop>(`${shopsBase(organizationId)}/${shopId}/archive`, { method: 'POST' });
  },
  getOpeningHours(organizationId: string, shopId: string) {
    return apiRequest<OpeningHoursResponse>(`${shopsBase(organizationId)}/${shopId}/opening-hours`);
  },
  replaceOpeningHours(organizationId: string, shopId: string, days: OpeningHourDay[]) {
    return apiRequest<OpeningHoursResponse>(`${shopsBase(organizationId)}/${shopId}/opening-hours`, {
      method: 'PUT',
      body: { days },
    });
  },
};

/** Query keys scoppées par organizationId : aucun mélange entre tenants. */
export const shopKeys = {
  all: (organizationId: string) => ['organizations', organizationId, 'shops'] as const,
  list: (organizationId: string, params: ListShopsParams) =>
    [...shopKeys.all(organizationId), 'list', params] as const,
  detail: (organizationId: string, shopId: string) =>
    [...shopKeys.all(organizationId), 'detail', shopId] as const,
  openingHours: (organizationId: string, shopId: string) =>
    [...shopKeys.all(organizationId), 'opening-hours', shopId] as const,
};
