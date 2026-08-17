import { MetaWebhookSignatureError } from '@whauto/shared';
import { buildMetaSignedRequest } from '@whauto/whatsapp';

import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../../prisma/prisma.service';
import { MetaAppCallbacksService } from './meta-app-callbacks.service';

const APP_SECRET = 'unit-app-secret';

function build() {
  const prisma = {
    metaWhatsAppCredential: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    whatsAppConnection: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    whatsAppChannel: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    metaDataDeletionRequest: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (arg: unknown) => (arg as (tx: unknown) => Promise<unknown>)(prisma));
  const config = {
    get: jest.fn((key: string) =>
      key === 'META_APP_SECRET' ? APP_SECRET : key === 'API_PUBLIC_URL' ? 'https://api.test' : undefined,
    ),
  };
  const service = new MetaAppCallbacksService(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService,
  );
  return { service, prisma };
}

describe('MetaAppCallbacksService', () => {
  it('deauthorize : signature invalide → 401 (MetaWebhookSignatureError), aucune écriture', async () => {
    const { service, prisma } = build();
    await expect(service.handleDeauthorize('forged.payload')).rejects.toThrow(MetaWebhookSignatureError);
    expect(prisma.metaWhatsAppCredential.updateMany).not.toHaveBeenCalled();
  });

  it('deauthorize : signé mais aucun credential actif → success, teardown no-op', async () => {
    const { service, prisma } = build();
    const signed = buildMetaSignedRequest({ user_id: 'FB1' }, APP_SECRET);
    await expect(service.handleDeauthorize(signed)).resolves.toEqual({ success: true });
    expect(prisma.whatsAppConnection.updateMany).not.toHaveBeenCalled();
    expect(prisma.metaWhatsAppCredential.updateMany).not.toHaveBeenCalled();
  });

  it('deauthorize : credential actif → connexion close + token révoqué + canal fermé', async () => {
    const { service, prisma } = build();
    prisma.metaWhatsAppCredential.findMany.mockResolvedValue([{ id: 'cred-1' }]);
    prisma.whatsAppConnection.findMany.mockResolvedValue([{ id: 'conn-1', shopId: 'shop-1', organizationId: 'org-1' }]);
    prisma.whatsAppConnection.updateMany.mockResolvedValue({ count: 1 });
    prisma.metaWhatsAppCredential.updateMany.mockResolvedValue({ count: 1 });

    const signed = buildMetaSignedRequest({ user_id: 'FB1' }, APP_SECRET);
    await service.handleDeauthorize(signed);

    expect(prisma.whatsAppConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DISCONNECTED' }) }),
    );
    expect(prisma.whatsAppChannel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1', shopId: 'shop-1', provider: 'META_CLOUD' }),
        data: expect.objectContaining({ status: 'DISCONNECTED' }),
      }),
    );
    expect(prisma.metaWhatsAppCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REVOKED' }) }),
    );
  });

  it('data-deletion : renvoie url + confirmation_code et trace la demande (même sans user_id)', async () => {
    const { service, prisma } = build();
    const signed = buildMetaSignedRequest({}, APP_SECRET); // pas de user_id
    const res = await service.handleDataDeletion(signed);
    expect(res.confirmation_code).toMatch(/^[a-f0-9]{32}$/);
    expect(res.url).toBe(`https://api.test/api/webhooks/whatsapp/meta/data-deletion/status?code=${res.confirmation_code}`);
    expect(prisma.metaDataDeletionRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ facebookUserId: 'unknown', status: 'PROCESSED' }) }),
    );
  });

  it('data-deletion : signature invalide → 401', async () => {
    const { service } = build();
    await expect(service.handleDataDeletion('bad')).rejects.toThrow(MetaWebhookSignatureError);
  });

  it('statut : code inconnu → not_found', async () => {
    const { service } = build();
    await expect(service.getDeletionStatus('nope')).resolves.toEqual({ status: 'not_found', confirmation_code: 'nope' });
  });
});
