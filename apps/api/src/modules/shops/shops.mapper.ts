import type { Prisma } from '@whauto/database';

/** Seuls champs Shop autorisés à sortir de la couche service. */
export const SHOP_PUBLIC_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  slug: true,
  description: true,
  status: true,
  isPrimary: true,
  businessType: true,
  logoUrl: true,
  coverUrl: true,
  websiteUrl: true,
  supportEmail: true,
  supportPhone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  latitude: true,
  longitude: true,
  countryCode: true,
  timezone: true,
  currency: true,
  locale: true,
  returnPolicy: true,
  deliveryPolicy: true,
  orderInstructions: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} satisfies Prisma.ShopSelect;

export type ShopPublic = Prisma.ShopGetPayload<{ select: typeof SHOP_PUBLIC_SELECT }>;

export const OPENING_HOUR_SELECT = {
  dayOfWeek: true,
  opensAtMinutes: true,
  closesAtMinutes: true,
} satisfies Prisma.ShopOpeningHourSelect;

export type OpeningHourRow = Prisma.ShopOpeningHourGetPayload<{
  select: typeof OPENING_HOUR_SELECT;
}>;
