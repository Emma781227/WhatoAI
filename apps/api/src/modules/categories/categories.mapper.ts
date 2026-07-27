import type { Prisma } from '@whauto/database';

/** Seuls champs ProductCategory autorisés à sortir de la couche service. */
export const CATEGORY_PUBLIC_SELECT = {
  id: true,
  organizationId: true,
  shopId: true,
  name: true,
  slug: true,
  description: true,
  imageUrl: true,
  status: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} satisfies Prisma.ProductCategorySelect;

export type CategoryPublic = Prisma.ProductCategoryGetPayload<{
  select: typeof CATEGORY_PUBLIC_SELECT;
}>;

/** Résumé embarqué dans les DTO produit. */
export const CATEGORY_SUMMARY_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
} satisfies Prisma.ProductCategorySelect;

export type CategorySummary = Prisma.ProductCategoryGetPayload<{
  select: typeof CATEGORY_SUMMARY_SELECT;
}>;
