import type { ConfigService } from '@nestjs/config';
import { Prisma } from '@whauto/database';
import { InvalidInboundEventError, WhatsAppChannelNotFoundError } from '@whauto/shared';
import type { Queue } from 'bullmq';

import type { PrismaService } from '../../prisma/prisma.service';
import { InboundIngestionService } from './inbound-ingestion.service';
import { WhatsAppProviderFactory } from './whatsapp-provider.factory';

function mockBody(externalEventId = 'evt-1') {
  return {
    mock: true,
    kind: 'message',
    externalEventId,
    externalMessageId: 'wamid.mock.1',
    from: '+237650123456',
    text: 'Bonjour',
    timestamp: '2026-07-17T10:00:00.000Z',
  };
}

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['channelId', 'externalEventId'] },
  });
}

function buildMocks() {
  const prisma = {
    whatsAppChannel: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'chan-1', organizationId: 'org-1', provider: 'MOCK', status: 'CONNECTED' }),
    },
    whatsAppInboundEvent: {
      create: jest.fn().mockResolvedValue({ id: 'evt-row-1' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'evt-row-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const configService = { get: jest.fn().mockReturnValue(undefined) };
  const service = new InboundIngestionService(
    prisma as unknown as PrismaService,
    new WhatsAppProviderFactory(configService as unknown as ConfigService),
    queue as unknown as Queue,
  );
  return { service, prisma, queue };
}

describe('InboundIngestionService — durable inbox', () => {
  it('persiste AVANT de publier, puis marque QUEUED conditionnellement', async () => {
    const { service, prisma, queue } = buildMocks();
    const result = await service.ingest('chan-1', { body: mockBody() });

    expect(result.inboundEventIds).toEqual(['evt-row-1']);
    // Ordre : create (persistance) appelé avant queue.add (publication).
    const createOrder = prisma.whatsAppInboundEvent.create.mock.invocationCallOrder[0];
    const addOrder = queue.add.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(addOrder);

    expect(queue.add).toHaveBeenCalledWith(
      'inbound-event',
      { inboundEventId: 'evt-row-1' },
      { jobId: 'evt-row-1' },
    );
    expect(prisma.whatsAppInboundEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt-row-1', status: 'RECEIVED' },
      data: expect.objectContaining({ status: 'QUEUED' }),
    });
  });

  it('panne Redis après persistance : ne lève pas, l’événement reste RECEIVED (récupérable)', async () => {
    const { service, prisma, queue } = buildMocks();
    queue.add.mockRejectedValue(new Error('Redis down'));

    const result = await service.ingest('chan-1', { body: mockBody() });

    expect(result.inboundEventIds).toEqual(['evt-row-1']); // ACK possible
    expect(prisma.whatsAppInboundEvent.create).toHaveBeenCalled();
    // Jamais marqué QUEUED : le sweep du worker le republiera.
    expect(prisma.whatsAppInboundEvent.updateMany).not.toHaveBeenCalled();
  });

  it('relivraison du même webhook : réutilise la ligne existante, aucune duplication', async () => {
    const { service, prisma } = buildMocks();
    prisma.whatsAppInboundEvent.create.mockRejectedValue(uniqueViolation());

    const result = await service.ingest('chan-1', { body: mockBody() });

    expect(result.inboundEventIds).toEqual(['evt-row-1']);
    expect(prisma.whatsAppInboundEvent.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          channelId_externalEventId: { channelId: 'chan-1', externalEventId: 'evt-1' },
        },
      }),
    );
  });

  it('canal inconnu ou DISCONNECTED → 404', async () => {
    const { service, prisma } = buildMocks();
    prisma.whatsAppChannel.findUnique.mockResolvedValue(null);
    await expect(service.ingest('chan-x', { body: mockBody() })).rejects.toThrow(
      WhatsAppChannelNotFoundError,
    );

    prisma.whatsAppChannel.findUnique.mockResolvedValue({
      id: 'chan-1',
      organizationId: 'org-1',
      provider: 'MOCK',
      status: 'DISCONNECTED',
    });
    await expect(service.ingest('chan-1', { body: mockBody() })).rejects.toThrow(
      WhatsAppChannelNotFoundError,
    );
  });

  it('événement non signé mock ou incomplet → 400, rien n’est persisté', async () => {
    const { service, prisma } = buildMocks();
    await expect(service.ingest('chan-1', { body: { kind: 'message' } })).rejects.toThrow(
      InvalidInboundEventError,
    );
    await expect(
      service.ingest('chan-1', { body: { ...mockBody(), text: undefined } }),
    ).rejects.toThrow(InvalidInboundEventError);
    expect(prisma.whatsAppInboundEvent.create).not.toHaveBeenCalled();
  });

  it('le payload persisté est l’événement NORMALISÉ (jamais de signature/header)', async () => {
    const { service, prisma } = buildMocks();
    await service.ingest('chan-1', {
      body: mockBody(),
      signature: 'sha256=SECRET-NEVER-STORED',
    });
    const data = prisma.whatsAppInboundEvent.create.mock.calls[0][0].data;
    const persisted = JSON.stringify(data.payload);
    expect(persisted).not.toContain('SECRET-NEVER-STORED');
    expect(persisted).not.toContain('signature');
    expect(data.payload).toMatchObject({ kind: 'message', text: 'Bonjour' });
  });
});
