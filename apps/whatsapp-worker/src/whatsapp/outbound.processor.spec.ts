import type { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import type { SecretsEncryptionService } from '../crypto/secrets-encryption.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { MessageStatusService } from './message-status.service';
import { OutboundProcessor } from './outbound.processor';
import { WhatsAppProviderFactory } from './whatsapp-provider.factory';

const CONFIG = {
  get: (key: string) =>
    ({
      WHATSAPP_MOCK_DELIVERY_DELAY_MS: 100,
      WHATSAPP_MOCK_READ_DELAY_MS: 50,
      WHATSAPP_JOB_ATTEMPTS: 3,
    })[key],
} as unknown as ConfigService;

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    status: 'PENDING',
    dispatchId: 'disp-1',
    textContent: 'Bonjour',
    channelId: 'chan-1',
    conversation: {
      id: 'conv-1',
      customerServiceWindowExpiresAt: new Date(Date.now() + 3600_000),
    },
    channel: { id: 'chan-1', provider: 'MOCK', status: 'CONNECTED', phoneNumber: '+237650000000', organizationId: 'org-1', shopId: 'shop-1' },
    contact: { normalizedPhone: '+237650123456' },
    ...overrides,
  };
}

function job(attemptsMade = 0): Job {
  return {
    data: { messageId: 'msg-1', dispatchId: 'disp-1' },
    attemptsMade,
    opts: { attempts: 3 },
  } as unknown as Job;
}

function buildMocks(row: Record<string, unknown> | null = messageRow()) {
  const prisma = {
    message: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const statusQueue = { add: jest.fn().mockResolvedValue({}) };
  const outboundQueue = { add: jest.fn() };
  const messageStatus = { emitStatusUpdated: jest.fn().mockResolvedValue(undefined) };
  const processor = new OutboundProcessor(
    prisma as unknown as PrismaService,
    new WhatsAppProviderFactory(
      CONFIG,
      {} as unknown as PrismaService,
      {} as unknown as SecretsEncryptionService,
    ),
    CONFIG,
    {} as Redis,
    statusQueue as unknown as Queue,
    outboundQueue as unknown as Queue,
    messageStatus as unknown as MessageStatusService,
  );
  return { processor, prisma, statusQueue, messageStatus };
}

describe('OutboundProcessor — gestion des retries BullMQ (validée)', () => {
  it('PENDING : passe QUEUED, envoie, passe SENT et programme DELIVERED puis READ', async () => {
    const { processor, prisma, statusQueue } = buildMocks();
    await processor.process(job());

    // PENDING → QUEUED conditionnel.
    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: { id: 'msg-1', status: 'PENDING' },
      data: { status: 'QUEUED' },
    });
    // → SENT avec externalMessageId, uniquement depuis les prédécesseurs valides.
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'msg-1', status: { in: ['PENDING', 'QUEUED'] } },
        data: expect.objectContaining({
          status: 'SENT',
          externalMessageId: expect.stringMatching(/^wamid\.mock\./),
        }),
      }),
    );
    // Plan mock : DELIVERED puis READ différés, jobIds stables.
    expect(statusQueue.add).toHaveBeenCalledTimes(2);
    expect(statusQueue.add.mock.calls[0][1]).toMatchObject({ status: 'DELIVERED' });
    expect(statusQueue.add.mock.calls[1][1]).toMatchObject({ status: 'READ' });
  });

  it('message déjà QUEUED (retry BullMQ) : la tentative CONTINUE, jamais d’échec "déjà QUEUED"', async () => {
    const { processor, prisma } = buildMocks(messageRow({ status: 'QUEUED' }));
    await expect(processor.process(job(1))).resolves.toBeUndefined();
    // L'envoi a bien eu lieu : transition vers SENT tentée.
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) }),
    );
  });

  it.each(['SENT', 'DELIVERED', 'READ'] as const)(
    'message %s : job considéré déjà traité (no-op, succès)',
    async (status) => {
      const { processor, prisma, statusQueue } = buildMocks(messageRow({ status }));
      await expect(processor.process(job())).resolves.toBeUndefined();
      expect(prisma.message.updateMany).not.toHaveBeenCalled();
      expect(statusQueue.add).not.toHaveBeenCalled();
    },
  );

  it('message FAILED : jamais renvoyé par le processor (retry explicite uniquement)', async () => {
    const { processor, prisma } = buildMocks(messageRow({ status: 'FAILED' }));
    await processor.process(job());
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('dispatchId différent (retry explicite entre-temps) : job périmé ignoré', async () => {
    const { processor, prisma } = buildMocks(messageRow({ dispatchId: 'disp-2' }));
    await processor.process(job());
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
  });

  it('fenêtre 24 h expirée au moment de l’envoi : FAILED déterministe, pas de retry', async () => {
    const row = messageRow();
    (row.conversation as { customerServiceWindowExpiresAt: Date }).customerServiceWindowExpiresAt =
      new Date(Date.now() - 1000);
    const { processor, prisma } = buildMocks(row);
    await expect(processor.process(job())).resolves.toBeUndefined();
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'CUSTOMER_SERVICE_WINDOW_EXPIRED',
        }),
      }),
    );
  });

  it('échec provider avant la dernière tentative : relance BullMQ (throw)', async () => {
    const { processor } = buildMocks(messageRow({ textContent: '!fail test' }));
    await expect(processor.process(job(0))).rejects.toThrow();
  });

  it('échec provider à la dernière tentative : FAILED avec le code provider, sans throw', async () => {
    const { processor, prisma } = buildMocks(messageRow({ textContent: '!fail test' }));
    await expect(processor.process(job(2))).resolves.toBeUndefined();
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['PENDING', 'QUEUED'] } }),
        data: expect.objectContaining({ status: 'FAILED', errorCode: 'MOCK_SIMULATED_FAILURE' }),
      }),
    );
  });

  it('émet message.status.updated sur SENT (le ✓ de l’UI, sinon l’horloge reste figée)', async () => {
    const { processor, messageStatus } = buildMocks();
    await processor.process(job());
    expect(messageStatus.emitStatusUpdated).toHaveBeenCalledWith('msg-1');
  });

  it('émet message.status.updated sur FAILED (l’agent voit l’échec en temps réel)', async () => {
    const row = messageRow();
    (row.conversation as { customerServiceWindowExpiresAt: Date }).customerServiceWindowExpiresAt =
      new Date(Date.now() - 1000);
    const { processor, messageStatus } = buildMocks(row);
    await processor.process(job());
    expect(messageStatus.emitStatusUpdated).toHaveBeenCalledWith('msg-1');
  });

  it('n’émet RIEN quand la transition conditionnelle ne s’applique pas (count 0)', async () => {
    const { processor, prisma, messageStatus } = buildMocks();
    prisma.message.updateMany.mockResolvedValue({ count: 0 });
    await processor.process(job());
    expect(messageStatus.emitStatusUpdated).not.toHaveBeenCalled();
  });

  it('job déjà traité (message SENT) : aucune émission parasite', async () => {
    const { processor, messageStatus } = buildMocks(messageRow({ status: 'SENT' }));
    await processor.process(job());
    expect(messageStatus.emitStatusUpdated).not.toHaveBeenCalled();
  });

  it('trace chaque tentative : attemptCount incrémenté + lastAttemptAt avant l’appel provider', async () => {
    const { processor, prisma } = buildMocks();
    await processor.process(job());
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attemptCount: { increment: 1 },
          lastAttemptAt: expect.any(Date),
        }),
      }),
    );
  });
});
