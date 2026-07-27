import type { Prisma } from '@whauto/database';

/**
 * Seuls champs User autorisés à sortir de la couche service.
 * passwordHash n'est jamais chargé via ce select — la protection ne repose
 * pas sur une exclusion en sérialisation mais sur le fait que la donnée
 * sensible n'est pas lue du tout.
 */
export const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  status: true,
  emailVerifiedAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type UserPublic = Prisma.UserGetPayload<{ select: typeof USER_PUBLIC_SELECT }>;
