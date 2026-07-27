import type { Prisma } from '@whauto/database';

/** Seuls champs Organization autorisés à sortir de la couche service. */
export const ORGANIZATION_PUBLIC_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  timezone: true,
  defaultCurrency: true,
  defaultLocale: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrganizationSelect;

export type OrganizationPublic = Prisma.OrganizationGetPayload<{
  select: typeof ORGANIZATION_PUBLIC_SELECT;
}>;

/**
 * Champs exposés pour un membre : identité minimale de l'utilisateur,
 * jamais passwordHash ni aucun champ interne (select explicite).
 */
export const MEMBER_PUBLIC_SELECT = {
  id: true,
  role: true,
  status: true,
  joinedAt: true,
  userId: true,
  user: { select: { firstName: true, lastName: true, email: true } },
} satisfies Prisma.MembershipSelect;

export type MemberPublic = Prisma.MembershipGetPayload<{ select: typeof MEMBER_PUBLIC_SELECT }>;

/** Invitation exposée à l'API : tokenHash exclu par construction. */
export const INVITATION_PUBLIC_SELECT = {
  id: true,
  organizationId: true,
  email: true,
  role: true,
  status: true,
  expiresAt: true,
  createdAt: true,
} satisfies Prisma.OrganizationInvitationSelect;

export type InvitationPublic = Prisma.OrganizationInvitationGetPayload<{
  select: typeof INVITATION_PUBLIC_SELECT;
}>;
