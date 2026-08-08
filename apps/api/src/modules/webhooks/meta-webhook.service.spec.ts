import { MetaWebhookSignatureError } from '@whauto/shared';

import type { ConfigService } from '@nestjs/config';

import type { PrismaService } from '../../prisma/prisma.service';
import type { InboundIngestionService } from '../whatsapp-inbound/inbound-ingestion.service';
import type { WhatsAppProviderFactory } from '../whatsapp-inbound/whatsapp-provider.factory';
import { MetaWebhookService } from './meta-webhook.service';

/**
 * Routage MULTI-TENANT du webhook Meta : un POST signé peut porter plusieurs
 * numéros (commerçants). Chaque groupe doit aller dans SON canal, jamais fusionné.
 */
function build(options: {
  configured?: boolean;
  valid?: boolean;
  groups?: Array<{ phoneNumberId: string; events: unknown[] }>;
  channels?: Array<{ id: string; organizationId: string; phoneNumberId: string }>;
}) {
  const provider = {
    validateInboundEvent: jest.fn().mockReturnValue(options.valid ?? true),
    parseInboundEventsByPhoneNumber: jest.fn().mockReturnValue(options.groups ?? []),
  };
  const providerFactory = {
    isMetaConfigured: jest.fn().mockReturnValue(options.configured ?? true),
    getMetaProvider: jest.fn().mockReturnValue(provider),
  };
  const prisma = {
    whatsAppChannel: {
      findMany: jest.fn().mockResolvedValue(options.channels ?? []),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const ingestion = { persistAndPublish: jest.fn().mockResolvedValue({ inboundEventIds: [] }) };
  const configService = { get: jest.fn() };
  const service = new MetaWebhookService(
    configService as unknown as ConfigService,
    prisma as unknown as PrismaService,
    ingestion as unknown as InboundIngestionService,
    providerFactory as unknown as WhatsAppProviderFactory,
  );
  return { service, provider, providerFactory, prisma, ingestion };
}

const input = { rawBody: '{}', signature: 'sha256=x', parsedBody: { entry: [] } };

describe('MetaWebhookService.handleEvent — routage multi-tenant', () => {
  it('route chaque groupe vers SON canal (jamais de fusion)', async () => {
    const { service, ingestion } = build({
      groups: [
        { phoneNumberId: 'PN_1', events: [{ externalMessageId: 'a' }] },
        { phoneNumberId: 'PN_2', events: [{ externalMessageId: 'b' }] },
      ],
      channels: [
        { id: 'chan-1', organizationId: 'org-1', phoneNumberId: 'PN_1' },
        { id: 'chan-2', organizationId: 'org-2', phoneNumberId: 'PN_2' },
      ],
    });

    await service.handleEvent(input);

    expect(ingestion.persistAndPublish).toHaveBeenCalledTimes(2);
    expect(ingestion.persistAndPublish).toHaveBeenCalledWith(
      { id: 'chan-1', organizationId: 'org-1' },
      [{ externalMessageId: 'a' }],
    );
    expect(ingestion.persistAndPublish).toHaveBeenCalledWith(
      { id: 'chan-2', organizationId: 'org-2' },
      [{ externalMessageId: 'b' }],
    );
  });

  it('phone_number_id inconnu → groupe ignoré (ACK), les autres restent traités', async () => {
    const { service, ingestion } = build({
      groups: [
        { phoneNumberId: 'PN_1', events: [{ externalMessageId: 'a' }] },
        { phoneNumberId: 'PN_UNKNOWN', events: [{ externalMessageId: 'z' }] },
      ],
      channels: [{ id: 'chan-1', organizationId: 'org-1', phoneNumberId: 'PN_1' }],
    });

    await service.handleEvent(input);

    expect(ingestion.persistAndPublish).toHaveBeenCalledTimes(1);
    expect(ingestion.persistAndPublish).toHaveBeenCalledWith(
      { id: 'chan-1', organizationId: 'org-1' },
      [{ externalMessageId: 'a' }],
    );
  });

  it('phone_number_id ambigu (2 canaux actifs) → le plus ancien (premier) gagne', async () => {
    const { service, ingestion } = build({
      groups: [{ phoneNumberId: 'PN_1', events: [{ externalMessageId: 'a' }] }],
      // findMany est trié createdAt asc : le premier est le plus ancien.
      channels: [
        { id: 'chan-old', organizationId: 'org-1', phoneNumberId: 'PN_1' },
        { id: 'chan-new', organizationId: 'org-9', phoneNumberId: 'PN_1' },
      ],
    });

    await service.handleEvent(input);

    expect(ingestion.persistAndPublish).toHaveBeenCalledTimes(1);
    expect(ingestion.persistAndPublish).toHaveBeenCalledWith(
      { id: 'chan-old', organizationId: 'org-1' },
      expect.anything(),
    );
  });

  it('signature invalide → MetaWebhookSignatureError, aucune ingestion', async () => {
    const { service, ingestion } = build({ valid: false, groups: [] });
    await expect(service.handleEvent(input)).rejects.toThrow(MetaWebhookSignatureError);
    expect(ingestion.persistAndPublish).not.toHaveBeenCalled();
  });

  it('Meta non configuré → ACK sans traitement (jamais de throw)', async () => {
    const { service, provider, ingestion } = build({ configured: false });
    await expect(service.handleEvent(input)).resolves.toBeUndefined();
    expect(provider.validateInboundEvent).not.toHaveBeenCalled();
    expect(ingestion.persistAndPublish).not.toHaveBeenCalled();
  });

  it('aucun groupe actionnable (ex. statut sent) → ACK sans requête canal', async () => {
    const { service, prisma, ingestion } = build({ groups: [] });
    await service.handleEvent(input);
    expect(prisma.whatsAppChannel.findMany).not.toHaveBeenCalled();
    expect(ingestion.persistAndPublish).not.toHaveBeenCalled();
  });
});
