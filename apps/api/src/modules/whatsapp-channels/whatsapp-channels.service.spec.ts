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
  );
  return { service, prisma, auditService };
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
  });
});
