import type { StockStatus } from '@whauto/shared';

import type { ProductStatus, ProductType, VariantStatus } from './api';

export const PRODUCT_STATUS_LABELS: Record<ProductStatus, string> = {
  DRAFT: 'Brouillon',
  ACTIVE: 'Actif',
  INACTIVE: 'Inactif',
  ARCHIVED: 'Archivé',
};

export const VARIANT_STATUS_LABELS: Record<VariantStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  ARCHIVED: 'Archivée',
};

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  PHYSICAL: 'Physique',
  SERVICE: 'Service',
  DIGITAL: 'Numérique',
};

export const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  IN_STOCK: 'En stock',
  LOW_STOCK: 'Stock faible',
  OUT_OF_STOCK: 'Rupture',
  NOT_TRACKED: 'Non suivi',
  BACKORDERED: 'Précommande',
};

export const STOCK_STATUS_CLASSES: Record<StockStatus, string> = {
  IN_STOCK: 'bg-primary-subtle text-primary',
  LOW_STOCK: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  OUT_OF_STOCK: 'bg-destructive/10 text-destructive',
  NOT_TRACKED: 'bg-muted text-muted-foreground',
  BACKORDERED: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300',
};
