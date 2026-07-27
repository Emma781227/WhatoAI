import { apiRequest } from '@/lib/api/client';

export type WhatsAppProviderType = 'MOCK' | 'META_CLOUD';
export type WhatsAppChannelStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'ERROR'
  | 'SUSPENDED';

export interface WhatsAppChannel {
  id: string;
  organizationId: string;
  shopId: string;
  provider: WhatsAppProviderType;
  status: WhatsAppChannelStatus;
  displayName: string;
  phoneNumber: string;
  phoneNumberId: string | null;
  wabaId: string | null;
  businessId: string | null;
  externalAccountId: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectMockChannelInput {
  displayName: string;
  phoneNumber: string;
}

function channelBase(organizationId: string, shopId: string): string {
  return `/organizations/${organizationId}/shops/${shopId}/whatsapp-channel`;
}

export const whatsappChannelsApi = {
  /** 404 = aucun canal courant (l'appelant traite ce cas, pas une erreur UI). */
  get(organizationId: string, shopId: string) {
    return apiRequest<WhatsAppChannel>(channelBase(organizationId, shopId));
  },
  connectMock(organizationId: string, shopId: string, input: ConnectMockChannelInput) {
    return apiRequest<WhatsAppChannel>(`${channelBase(organizationId, shopId)}/mock`, {
      method: 'POST',
      body: input,
    });
  },
  disconnect(organizationId: string, shopId: string) {
    return apiRequest<WhatsAppChannel>(`${channelBase(organizationId, shopId)}/disconnect`, {
      method: 'POST',
    });
  },
};

/** Query keys scoppées organizationId + shopId : aucun mélange inter-tenant/inter-shop. */
export const whatsappChannelKeys = {
  all: (organizationId: string) => ['organizations', organizationId, 'whatsapp-channels'] as const,
  forShop: (organizationId: string, shopId: string) =>
    [...whatsappChannelKeys.all(organizationId), 'shop', shopId] as const,
};
