import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';

import type { PrismaService } from '../prisma/prisma.service';
import { RecoveryService } from './recovery.service';

const CONFIG = {
  get: (key: string) =>
    ({
      WHATSAPP_JOB_ATTEMPTS: 3,
      WHATSAPP_RECOVERY_SWEEP_INTERVAL_MS: 30000,
      WHATSAPP_RECOVERY_STALENESS_MS: 60000,
    })[key],
} as unknown as ConfigService;

function buildMocks() {
  const prisma = {
    whatsAppInboundEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    outboxEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const inboundQueue = { add: jest.fn().mockResolvedValue({}) };
  const outboundQueue = { add: jest.fn().mockResolvedValue({}) };
  const service = new RecoveryService(
    prisma as unknown as PrismaService,
    CONFIG,
    inboundQueue as unknown as Queue,
    outboundQueue as unknown as Queue,
  );
  return { service, prisma, inboundQueue, outboundQueue };
}

describe('RecoveryService — récupération après panne (API, worker ou Redis)', () => {
  it('republie les InboundEvent bloqués et les repasse QUEUED', async () => {
    const { service, prisma, inboundQueue } = buildMocks();
    prisma.whatsAppInboundEvent.findMany.mockResolvedValue([
      { id: 'evt-1', attemptCount: 0 },
      { id: 'evt-2', attemptCount: 2 },
    ]);

    const result = await service.sweep();

    expect(result.inboundRecovered).toBe(2);
    // jobId versionné par attemptCount : un échec conservé dans Redis ne
    // bloque pas indéfiniment la récupération.
    expect(inboundQueue.add).toHaveBeenCalledWith(
      'inbound-event',
      { inboundEventId: 'evt-1' },
      { jobId: 'evt-1.sweep.0' },
    );
    expect(inboundQueue.add).toHaveBeenCalledWith(
      'inbound-event',
      { inboundEventId: 'evt-2' },
      { jobId: 'evt-2.sweep.2' },
    );
  });

  it('sélectionne RECEIVED/QUEUED/PROCESSING périmés et FAILED sous le plafond de tentatives', async () => {
    const { service, prisma } = buildMocks();
    await service.sweep();
    const where = prisma.whatsAppInboundEvent.findMany.mock.calls[0][0].where;
    expect(where.OR[0].status.in).toEqual(['RECEIVED', 'QUEUED', 'PROCESSING']);
    expect(where.OR[1]).toMatchObject({ status: 'FAILED', attemptCount: { lt: 3 } });
  });

  it('republie les OutboxEvent PENDING avec jobId = dispatchId (jamais de double envoi logique)', async () => {
    const { service, prisma, outboundQueue } = buildMocks();
    prisma.outboxEvent.findMany.mockResolvedValue([
      {
        id: 'outbox-1',
        eventType: 'WHATSAPP_MESSAGE_SEND_REQUESTED',
        payload: { messageId: 'msg-1', dispatchId: 'disp-1' },
      },
    ]);

    const result = await service.sweep();

    expect(result.outboxRecovered).toBe(1);
    expect(outboundQueue.add).toHaveBeenCalledWith(
      'send-message',
      { messageId: 'msg-1', dispatchId: 'disp-1' },
      { jobId: 'disp-1' },
    );
    // Marqué PUBLISHED conditionnellement (status PENDING uniquement).
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'outbox-1', status: 'PENDING' },
        data: expect.objectContaining({ status: 'PUBLISHED' }),
      }),
    );
  });

  it('Redis toujours en panne pendant le sweep : l’outbox reste PENDING, erreur tracée', async () => {
    const { service, prisma, outboundQueue } = buildMocks();
    prisma.outboxEvent.findMany.mockResolvedValue([
      {
        id: 'outbox-1',
        eventType: 'WHATSAPP_MESSAGE_SEND_REQUESTED',
        payload: { messageId: 'msg-1', dispatchId: 'disp-1' },
      },
    ]);
    outboundQueue.add.mockRejectedValue(new Error('Redis down'));

    const result = await service.sweep();

    expect(result.outboxRecovered).toBe(0);
    // Jamais marqué PUBLISHED — attemptCount/lastErrorMessage seulement.
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attemptCount: { increment: 1 } }),
      }),
    );
    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'PUBLISHED' }) }),
    );
  });

  it('deux sweeps simultanés : le second est un no-op', async () => {
    const { service, prisma } = buildMocks();
    let release: () => void = () => undefined;
    prisma.whatsAppInboundEvent.findMany.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve([]); }),
    );
    const first = service.sweep();
    const second = await service.sweep();
    expect(second).toEqual({ inboundRecovered: 0, outboxRecovered: 0 });
    release();
    await first;
  });
});
