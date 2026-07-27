import type { Prisma } from '@whauto/database';

/**
 * Seuls champs WhatsAppChannel autorisés à sortir de la couche service.
 * accessTokenEncrypted et webhookSecretEncrypted n'en font JAMAIS partie :
 * ils ne sont ni chargés hors besoin, ni sérialisés.
 */
export const WHATSAPP_CHANNEL_PUBLIC_SELECT = {
  id: true,
  organizationId: true,
  shopId: true,
  provider: true,
  status: true,
  displayName: true,
  phoneNumber: true,
  phoneNumberId: true,
  wabaId: true,
  businessId: true,
  externalAccountId: true,
  displayPhoneNumber: true,
  verifiedName: true,
  connectedAt: true,
  disconnectedAt: true,
  lastWebhookAt: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WhatsAppChannelSelect;

export type WhatsAppChannelPublic = Prisma.WhatsAppChannelGetPayload<{
  select: typeof WHATSAPP_CHANNEL_PUBLIC_SELECT;
}>;

/**
 * Statuts occupant le slot "canal actif" d'une Shop (index unique partiel
 * whatsapp_channels_one_active_per_shop). ERROR n'en fait volontairement PAS
 * partie : un canal en erreur est remplaçable sans le déconnecter d'abord.
 */
export const ACTIVE_CHANNEL_STATUSES = ['CONNECTING', 'CONNECTED', 'SUSPENDED'] as const;
