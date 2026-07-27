import { readFileSync } from 'node:fs';

import { PrismaClient } from '@whauto/database';
import type { Queue } from 'bullmq';

import type { PrismaService } from '../prisma/prisma.service';
import { AiOutboundSenderService } from './ai-outbound-sender.service';
import type { AiRealtimeEmitter } from './ai-realtime-emitter.service';

/**
 * Tests d'INTÉGRATION du chemin d'envoi outbound de l'IA (sous-phase C, C1)
 * contre la vraie base. La queue BullMQ et l'émetteur temps réel sont MOCKÉS
 * (aucun Redis requis) ; PostgreSQL est réel car les invariants (FK, OutboxEvent,
 * compteurs de conversation) ne se prouvent qu'en base. Le service n'est PAS
 * encore branché à la décision IA (ce sera C2) : on l'exerce directement.
 */

jest.setTimeout(60000);

function databaseUrl(): string {
  const raw = readFileSync('C:/Users/Emma/Desktop/Whauto AI/.env', 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL introuvable');
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
const SUFFIX = `aiout-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ids: Record<string, string> = {};

interface QueueAddCall {
  name: string;
  data: { messageId: string; dispatchId: string };
  opts: { jobId?: string };
}

/** Construit le service avec une queue et un émetteur mockés. */
function makeService(queueAdd: jest.Mock): {
  service: AiOutboundSenderService;
  emit: jest.Mock;
} {
  const emit = jest.fn();
  const emitter = { emitToOrganization: emit } as unknown as AiRealtimeEmitter;
  const queue = { add: queueAdd } as unknown as Queue;
  const service = new AiOutboundSenderService(
    prisma as unknown as PrismaService,
    emitter,
    queue,
  );
  return { service, emit };
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `AI Outbound ${SUFFIX}`, slug: SUFFIX },
    select: { id: true },
  });
  ids.org = org.id;

  const shop = await prisma.shop.create({
    data: {
      organizationId: org.id,
      name: 'Shop',
      slug: `shop-${SUFFIX}`,
      status: 'ACTIVE',
      countryCode: 'CM',
      timezone: 'Africa/Douala',
      currency: 'XAF',
      locale: 'fr',
    },
    select: { id: true },
  });
  ids.shop = shop.id;

  const channel = await prisma.whatsAppChannel.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      provider: 'MOCK',
      status: 'CONNECTED',
      displayName: 'Canal',
      phoneNumber: '+237600000000',
    },
    select: { id: true },
  });
  ids.channel = channel.id;

  const contact = await prisma.contact.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      whatsappPhone: '+237600000001',
      normalizedPhone: '+237600000001',
    },
    select: { id: true },
  });
  ids.contact = contact.id;

  const conversation = await prisma.conversation.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      channelId: channel.id,
      contactId: contact.id,
      status: 'OPEN',
    },
    select: { id: true },
  });
  ids.conversation = conversation.id;

  const trigger = await prisma.message.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      conversationId: conversation.id,
      channelId: channel.id,
      contactId: contact.id,
      direction: 'INBOUND',
      type: 'TEXT',
      status: 'RECEIVED',
      senderType: 'CUSTOMER',
      textContent: 'bonjour',
    },
    select: { id: true },
  });

  const run = await prisma.aiRun.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      conversationId: conversation.id,
      triggerMessageId: trigger.id,
      contextLastMessageId: trigger.id,
      provider: 'MOCK',
      model: 'mock-model',
      mode: 'AUTO_REPLY',
      status: 'RUNNING',
    },
    select: { id: true },
  });
  ids.run = run.id;
});

afterAll(async () => {
  const org = ids.org;
  if (org) {
    await prisma.outboxEvent.deleteMany({ where: { organizationId: org } });
    await prisma.aiRun.deleteMany({ where: { organizationId: org } });
    await prisma.message.deleteMany({ where: { organizationId: org } });
    await prisma.conversation.deleteMany({ where: { organizationId: org } });
    await prisma.contact.deleteMany({ where: { organizationId: org } });
    await prisma.whatsAppChannel.deleteMany({ where: { organizationId: org } });
    await prisma.shop.deleteMany({ where: { organizationId: org } });
    await prisma.organization.delete({ where: { id: org } });
  }
  await prisma.$disconnect();
});

describe('AiOutboundSenderService (C1 — chemin d envoi worker)', () => {
  it('crée un Message OUTBOUND/AI/PENDING marqué et relié au run', async () => {
    const queueAdd = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(queueAdd);

    const { messageId, dispatchId } = await service.sendAiReply({
      organizationId: ids.org,
      aiRunId: ids.run,
      conversationId: ids.conversation,
      text: 'Bonjour, le sac est disponible à 15 000 XAF.',
    });

    const message = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      select: {
        direction: true,
        type: true,
        status: true,
        senderType: true,
        senderUserId: true,
        clientMessageId: true,
        isAiGenerated: true,
        aiGeneratedByRunId: true,
        textContent: true,
        dispatchId: true,
      },
    });
    expect(message.direction).toBe('OUTBOUND');
    expect(message.type).toBe('TEXT');
    expect(message.status).toBe('PENDING');
    expect(message.senderType).toBe('AI');
    expect(message.senderUserId).toBeNull(); // Aucun humain émetteur.
    expect(message.clientMessageId).toBeNull(); // Aucun frontend.
    expect(message.isAiGenerated).toBe(true);
    expect(message.aiGeneratedByRunId).toBe(ids.run);
    expect(message.textContent).toBe('Bonjour, le sac est disponible à 15 000 XAF.');
    expect(message.dispatchId).toBe(dispatchId);
  });

  it('met à jour les compteurs de conversation (lastMessageAt / lastOutboundMessageAt)', async () => {
    const before = await prisma.conversation.findUniqueOrThrow({
      where: { id: ids.conversation },
      select: { lastOutboundMessageAt: true },
    });

    const queueAdd = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(queueAdd);
    await service.sendAiReply({
      organizationId: ids.org,
      aiRunId: ids.run,
      conversationId: ids.conversation,
      text: 'Deuxième réponse.',
    });

    const after = await prisma.conversation.findUniqueOrThrow({
      where: { id: ids.conversation },
      select: { lastMessageAt: true, lastOutboundMessageAt: true },
    });
    expect(after.lastOutboundMessageAt).not.toBeNull();
    expect(after.lastOutboundMessageAt!.getTime()).toBeGreaterThanOrEqual(
      before.lastOutboundMessageAt?.getTime() ?? 0,
    );
    expect(after.lastMessageAt.getTime()).toBe(after.lastOutboundMessageAt!.getTime());
  });

  it('crée EXACTEMENT un OutboxEvent, publie une fois (jobId = dispatchId) et le marque PUBLISHED', async () => {
    const queueAdd = jest.fn().mockResolvedValue(undefined);
    const { service, emit } = makeService(queueAdd);

    const { messageId, dispatchId } = await service.sendAiReply({
      organizationId: ids.org,
      aiRunId: ids.run,
      conversationId: ids.conversation,
      text: 'Troisième réponse.',
    });

    const events = await prisma.outboxEvent.findMany({
      where: { organizationId: ids.org, payload: { path: ['messageId'], equals: messageId } },
      select: { status: true, eventType: true, payload: true, publishedAt: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('WHATSAPP_MESSAGE_SEND_REQUESTED');
    expect(events[0].status).toBe('PUBLISHED');
    expect(events[0].publishedAt).not.toBeNull();
    expect(events[0].payload).toMatchObject({ messageId, dispatchId });

    // Publication BullMQ : un seul add, jobId = dispatchId (idempotence d'envoi).
    expect(queueAdd).toHaveBeenCalledTimes(1);
    const call = queueAdd.mock.calls[0] as unknown as [
      QueueAddCall['name'],
      QueueAddCall['data'],
      QueueAddCall['opts'],
    ];
    expect(call[0]).toBe('send-message');
    expect(call[1]).toEqual({ messageId, dispatchId });
    expect(call[2].jobId).toBe(dispatchId);

    // Temps réel : message.created + conversation.updated émis.
    const emittedEvents = emit.mock.calls.map((c) => c[1]);
    expect(emittedEvents).toContain('message.created');
    expect(emittedEvents).toContain('conversation.updated');
  });

  it('best-effort : si la publication BullMQ échoue, le Message est créé et l OutboxEvent reste PENDING (repris par le sweep)', async () => {
    const queueAdd = jest.fn().mockRejectedValue(new Error('redis indisponible'));
    const { service } = makeService(queueAdd);

    const { messageId } = await service.sendAiReply({
      organizationId: ids.org,
      aiRunId: ids.run,
      conversationId: ids.conversation,
      text: 'Réponse avec Redis KO.',
    });

    // Le message existe bien (PENDING) — l'échec de publication ne l'annule pas.
    const message = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      select: { status: true },
    });
    expect(message.status).toBe('PENDING');

    // L'OutboxEvent reste PENDING avec la trace d'erreur : le sweep le republiera.
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { organizationId: ids.org, payload: { path: ['messageId'], equals: messageId } },
      select: { status: true, attemptCount: true, lastErrorMessage: true },
    });
    expect(event.status).toBe('PENDING');
    expect(event.attemptCount).toBeGreaterThanOrEqual(1);
    expect(event.lastErrorMessage).toContain('redis');
  });

  it('createAiOutboundInTx est idempotent côté publication : republier un OutboxEvent déjà PUBLISHED est un no-op', async () => {
    const queueAdd = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(queueAdd);

    // Création dans une transaction, puis DEUX publications successives.
    const dispatchId = `dispatch-${SUFFIX}-idem`;
    const created = await prisma.$transaction((tx) =>
      service.createAiOutboundInTx(tx, {
        organizationId: ids.org,
        aiRunId: ids.run,
        conversation: {
          id: ids.conversation,
          shopId: ids.shop,
          channelId: ids.channel,
          contactId: ids.contact,
        },
        text: 'Réponse idempotente.',
        dispatchId,
      }),
    );

    await service.publishAndEmit(ids.org, created.messageId, created.outboxEventId);
    await service.publishAndEmit(ids.org, created.messageId, created.outboxEventId);

    // La seconde publication voit le statut PUBLISHED et n'ajoute pas de job.
    expect(queueAdd).toHaveBeenCalledTimes(1);
    const event = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: created.outboxEventId },
      select: { status: true, attemptCount: true },
    });
    expect(event.status).toBe('PUBLISHED');
    expect(event.attemptCount).toBe(1);
  });
});
