import type { Prisma } from '@whauto/database';

/** Seuls champs Contact autorisés à sortir de la couche service. */
export const CONTACT_PUBLIC_SELECT = {
  id: true,
  organizationId: true,
  shopId: true,
  externalId: true,
  whatsappPhone: true,
  normalizedPhone: true,
  displayName: true,
  profilePictureUrl: true,
  email: true,
  language: true,
  city: true,
  countryCode: true,
  notes: true,
  status: true,
  lastActivityAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ContactSelect;

export type ContactPublic = Prisma.ContactGetPayload<{ select: typeof CONTACT_PUBLIC_SELECT }>;

/** Résumé embarqué dans les listes de conversations. */
export const CONTACT_SUMMARY_SELECT = {
  id: true,
  displayName: true,
  whatsappPhone: true,
  normalizedPhone: true,
  profilePictureUrl: true,
} satisfies Prisma.ContactSelect;

export type ContactSummary = Prisma.ContactGetPayload<{ select: typeof CONTACT_SUMMARY_SELECT }>;
