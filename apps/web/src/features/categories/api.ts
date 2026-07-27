import { apiRequest } from '@/lib/api/client';

export type CategoryStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

export interface Category {
  id: string;
  organizationId: string;
  shopId: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  status: CategoryStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface PaginatedCategories {
  items: Category[];
  total: number;
  page: number;
  limit: number;
}

export interface ListCategoriesParams {
  page?: number;
  limit?: number;
  search?: string;
  status?: CategoryStatus;
  includeArchived?: boolean;
}

export interface CreateCategoryInput {
  name: string;
  slug?: string;
  description?: string;
  imageUrl?: string;
  sortOrder?: number;
}

/** Convention backend : undefined = inchangé, null = effacement. */
export type UpdateCategoryInput = Partial<{
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
  status: 'ACTIVE' | 'INACTIVE';
}>;

function base(organizationId: string, shopId: string): string {
  return `/organizations/${organizationId}/shops/${shopId}/categories`;
}

export const categoriesApi = {
  list(organizationId: string, shopId: string, params: ListCategoriesParams = {}) {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.search) query.set('search', params.search);
    if (params.status) query.set('status', params.status);
    if (params.includeArchived) query.set('includeArchived', 'true');
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return apiRequest<PaginatedCategories>(`${base(organizationId, shopId)}${suffix}`);
  },
  create(organizationId: string, shopId: string, input: CreateCategoryInput) {
    return apiRequest<Category>(base(organizationId, shopId), { method: 'POST', body: input });
  },
  update(organizationId: string, shopId: string, categoryId: string, input: UpdateCategoryInput) {
    return apiRequest<Category>(`${base(organizationId, shopId)}/${categoryId}`, {
      method: 'PATCH',
      body: input,
    });
  },
  archive(organizationId: string, shopId: string, categoryId: string) {
    return apiRequest<Category>(`${base(organizationId, shopId)}/${categoryId}/archive`, {
      method: 'POST',
    });
  },
};

/** Query keys scoppées organizationId + shopId : zéro fuite inter-Shop. */
export const categoryKeys = {
  all: (organizationId: string, shopId: string) =>
    ['organizations', organizationId, 'shops', shopId, 'categories'] as const,
  list: (organizationId: string, shopId: string, params: ListCategoriesParams) =>
    [...categoryKeys.all(organizationId, shopId), 'list', params] as const,
};
