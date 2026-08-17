import {
  InvalidPhoneNumberError,
  ShopArchivedError,
  ShopNotFoundError,
  WhatsAppChannelAlreadyActiveError,
  WhatsAppChannelNotFoundError,
} from '@whauto/shared';

import type { ConfigService } from '@nestjs/config';

import { ROLE_PERMISSIONS } from '../../common/tenant/permissions';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import type { PrismaService } from '../../prisma/prisma.service';
import type { OrganizationAuditService } from '../organizations/organization-audit.service';
import type { WhatsAppProviderFactory } from '../whatsapp-inbound/whatsapp-provider.factory';
import { WhatsAppChannelsService } from './whatsapp-channels.service';

const TENANT: TenantContext = {
  userId: 'user-1',
  organizationId: 'org-1',
  membershipId: 'membership-1',
  role: 'ADMIN',
  permissions: ROLE_PERMISSIONS.ADMIN,
};

function channelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chan-1',
    organizationId: 'org-1',
    shopId: 'shop-1',
    provider: 'MOCK',
    status: 'CONNECTED',
    displayName: 'Boutique Douala',
    phoneNumber: '+237650000000',
    ...overrides,
  };
}

function buildMocks() {
  const prisma = {
    shop: {
      findFirst: jest.fn().mockResolvedValue({ id: 'shop-1', status: 'ACTIVE' }),
    },
    whatsAppChannel: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(channelRow()),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(channelRow()),
    },
    whatsAppConnection: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    metaWhatsAppCredential: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (arg: unknown) =>
    (arg as (tx: unknown) => Promise<unknown>)(prisma),
  );
  const auditService = { record: jest.fn().mockResolvedValue({}), recordSafe: jest.fn().mockResolvedValue({}) };
  const providerFactory = {
    isMetaConfigured: jest.fn().mockReturnValue(false),
    getMetaProvider: jest.fn(),
    getProvider: jest.fn(),
  };
  const configService = { get: jest.fn().mockReturnValue(undefined) };
  const service = new WhatsAppChannelsService(
    prisma as unknown as PrismaService,
    auditService as unknown as OrganizationAuditService,
    providerFactory as unknown as WhatsAppProviderFactory,
    configService as unknown as ConfigService,
    { isConfigured: () => true, encrypt: (s: string) => `v1.enc.${s}`, decrypt: (s: string) => s } as unknown as import('../../crypto/secrets-encryption.service').SecretsEncryptionService,
  );
  return { service, prisma, auditService, providerFactory, configService };
}

describe('WhatsAppChannelsService', () => {
  describe('connectMock', () => {
    it('crée un canal CONNECTED + audit dans la même transaction', async () => {
      const { service, prisma, auditService } = buildMocks();
      const result = await service.connectMock(
        TENANT,
        'shop-1',
        { displayName: 'Boutique Douala', phoneNumber: '+237 650 00 00 00' },
        {},
      );
      expect(result.id).toBe('chan-1');
      expect(prisma.whatsAppChannel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: 'org-1',
            provider: 'MOCK',
            status: 'CONNECTED',
            phoneNumber: '+237650000000', // normalisé E.164
          }),
        }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'WHATSAPP_CHANNEL_CONNECTED' }),
        prisma,
      );
    });

    it('shop introuvable ou d’une autre organisation → 404', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue(null);
      await expect(
        service.connectMock(TENANT, 'shop-x', { displayName: 'X', phoneNumber: '+237650000000' }, {}),
      ).rejects.toThrow(ShopNotFoundError);
    });

    it('shop archivée refusée', async () => {
      const { service, prisma } = buildMocks();
      prisma.shop.findFirst.mockResolvedValue({ id: 'shop-1', status: 'ARCHIVED' });
      await expect(
        service.connectMock(TENANT, 'shop-1', { displayName: 'X', phoneNumber: '+237650000000' }, {}),
      ).rejects.toThrow(ShopArchivedError);
    });

    it('numéro invalide refusé', async () => {
      const { service } = buildMocks();
      await expect(
        service.connectMock(TENANT, 'shop-1', { displayName: 'X', phoneNumber: '0650' }, {}),
      ).rejects.toThrow(InvalidPhoneNumberError);
    });

    it('canal actif existant → 409', async () => {
      const { service, prisma } = buildMocks();
      prisma.whatsAppChannel.findFirst.mockResolvedValue(channelRow());
      await expect(
        service.connectMock(TENANT, 'shop-1', { displayName: 'X', phoneNumber: '+237650000000' }, {}),
      ).rejects.toThrow(WhatsAppChannelAlreadyActiveError);
    });

    it('un canal ERROR ne bloque pas : il est clos et remplacé dans la transaction', async () => {
      const { service, prisma } = buildMocks();
      // findFirst (slot actif) = null : ERROR n'occupe pas le slot.
      await service.connectMock(
        TENANT,
        'shop-1',
        { displayName: 'X', phoneNumber: '+237650000000' },
        {},
      );
      expect(prisma.whatsAppChannel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'ERROR' }),
          data: expect.objectContaining({ status: 'DISCONNECTED' }),
        }),
      );
    });
  });

  describe('getForShop', () => {
    it('renvoie le canal actif, sinon le dernier ERROR, sinon 404', async () => {
      const { service, prisma } = buildMocks();
      prisma.whatsAppChannel.findFirst
        .mockResolvedValueOnce(null) // pas d'actif
        .mockResolvedValueOnce(channelRow({ status: 'ERROR' }));
      const result = await service.getForShop(TENANT, 'shop-1');
      expect(result.status).toBe('ERROR');

      prisma.whatsAppChannel.findFirst.mockResolvedValue(null);
      await expect(service.getForShop(TENANT, 'shop-1')).rejects.toThrow(
        WhatsAppChannelNotFoundError,
      );
    });
  });

  describe('disconnect', () => {
    it('transition conditionnelle vers DISCONNECTED + audit', async () => {
      const { service, prisma, auditService } = buildMocks();
      prisma.whatsAppChannel.findFirst.mockResolvedValue(channelRow());
      prisma.whatsAppChannel.updateMany.mockResolvedValue({ count: 1 });
      await service.disconnect(TENANT, 'shop-1', {});
      expect(prisma.whatsAppChannel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'DISCONNECTED' }),
        }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'WHATSAPP_CHANNEL_DISCONNECTED' }),
        prisma,
      );
    });

    it('déconnexion concurrente (count=0) → 404', async () => {
      const { service, prisma } = buildMocks();
      prisma.whatsAppChannel.findFirst.mockResolvedValue(channelRow());
      prisma.whatsAppChannel.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.disconnect(TENANT, 'shop-1', {})).rejects.toThrow(
        WhatsAppChannelNotFoundError,
      );
    });

    it('aucun canal actif ni ERROR → 404', async () => {
      const { service, prisma } = buildMocks();
      prisma.whatsAppChannel.findFirst.mockResolvedValue(null);
      await expect(service.disconnect(TENANT, 'shop-1', {})).rejects.toThrow(
        WhatsAppChannelNotFoundError,
      );
    });

    it('multi-tenant : clôt la connexion ET révoque le credential (token inutilisable)', async () => {
      const { service, prisma } = buildMocks();
      prisma.whatsAppChannel.findFirst.mockResolvedValue(channelRow({ provider: 'META_CLOUD' }));
      prisma.whatsAppChannel.updateMany.mockResolvedValue({ count: 1 });
      prisma.whatsAppConnection.findMany.mockResolvedValue([
        { id: 'conn-1', metaWhatsAppCredentialId: 'cred-1' },
      ]);
      prisma.whatsAppConnection.updateMany.mockResolvedValue({ count: 1 });
      prisma.metaWhatsAppCredential.updateMany.mockResolvedValue({ count: 1 });

      await service.disconnect(TENANT, 'shop-1', {});

      expect(prisma.whatsAppConnection.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['conn-1'] } },
          data: expect.objectContaining({ status: 'DISCONNECTED' }),
        }),
      );
      expect(prisma.metaWhatsAppCredential.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { in: ['cred-1'] },
            status: { not: 'REVOKED' },
          }),
          data: expect.objectContaining({ status: 'REVOKED' }),
        }),
      );
    });

    it('MOCK/pilote : aucune connexion → aucune révocation de credential', async () => {
      const { service, prisma } = buildMocks();
      prisma.whatsAppChannel.findFirst.mockResolvedValue(channelRow());
      prisma.whatsAppChannel.updateMany.mockResolvedValue({ count: 1 });
      // findMany renvoie [] par défaut (aucune connexion Meta).
      await service.disconnect(TENANT, 'shop-1', {});
      expect(prisma.whatsAppConnection.updateMany).not.toHaveBeenCalled();
      expect(prisma.metaWhatsAppCredential.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('profil WhatsApp Business (pilote)', () => {
    const PROFILE = {
      about: 'Ma boutique',
      address: null,
      description: null,
      email: null,
      vertical: 'RETAIL',
      websites: [],
      profilePictureUrl: null,
    };

    function withMetaChannel() {
      const built = buildMocks();
      // getMetaChannel : un canal META_CLOUD actif.
      built.prisma.whatsAppChannel.findFirst.mockResolvedValue(
        channelRow({ provider: 'META_CLOUD' }),
      );
      built.providerFactory.isMetaConfigured.mockReturnValue(true);
      // META_MULTI_TENANT_ENABLED absent → chemin pilote (provider env).
      built.configService.get.mockReturnValue(undefined);
      return built;
    }

    it('getBusinessProfile renvoie le profil du provider (GET, aucun envoi)', async () => {
      const built = withMetaChannel();
      const provider = { getBusinessProfile: jest.fn().mockResolvedValue(PROFILE) };
      built.providerFactory.getMetaProvider.mockReturnValue(provider);

      const result = await built.service.getBusinessProfile(TENANT, 'shop-1');
      expect(result).toEqual(PROFILE);
      expect(provider.getBusinessProfile).toHaveBeenCalledTimes(1);
    });

    it('updateBusinessProfile n’envoie que les champs fournis + audite les NOMS de champs', async () => {
      const built = withMetaChannel();
      const provider = {
        updateBusinessProfile: jest.fn().mockResolvedValue(undefined),
        getBusinessProfile: jest.fn().mockResolvedValue(PROFILE),
      };
      built.providerFactory.getMetaProvider.mockReturnValue(provider);

      const result = await built.service.updateBusinessProfile(
        TENANT,
        'shop-1',
        { about: 'Nouveau', vertical: undefined, websites: ['https://x.co'] },
        {},
      );
      expect(result).toEqual(PROFILE);
      // vertical (undefined) exclu ; seuls about + websites envoyés.
      expect(provider.updateBusinessProfile).toHaveBeenCalledWith({
        about: 'Nouveau',
        websites: ['https://x.co'],
      });
      expect(built.auditService.recordSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'META_PROFILE_UPDATED',
          metadata: expect.objectContaining({ changedFields: ['about', 'websites'] }),
        }),
      );
    });

    it('erreur provider → MetaApiError (jamais l’erreur brute)', async () => {
      const built = withMetaChannel();
      const { WhatsAppProviderSendError } = jest.requireActual('@whauto/whatsapp');
      const provider = {
        getBusinessProfile: jest
          .fn()
          .mockRejectedValue(new WhatsAppProviderSendError('x', 'META_190', 'CONFIGURATION_ERROR')),
      };
      built.providerFactory.getMetaProvider.mockReturnValue(provider);
      await expect(built.service.getBusinessProfile(TENANT, 'shop-1')).rejects.toMatchObject({
        code: 'META_190',
      });
    });
  });
});
