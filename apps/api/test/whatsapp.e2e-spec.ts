// Overrides d'environnement AVANT l'import d'AppModule (dotenv n'écrase pas
// les variables déjà présentes). Redis DB 1 dédiée aux tests, délais mock
// courts, endpoints de simulation activés.
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.AUTH_EXPOSE_TEST_TOKENS = 'true';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.ENABLE_MOCK_WHATSAPP_ENDPOINTS = 'true';
process.env.WHATSAPP_JOB_ATTEMPTS = '2';
process.env.WHATSAPP_JOB_BACKOFF_MS = '200';
process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REGISTER_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REFRESH_MAX = '1000';
process.env.AUTH_RATE_LIMIT_RESET_MAX = '1000';
process.env.AUTH_RATE_LIMIT_FORGOT_PASSWORD_MAX = '1000';
process.env.AUTH_RATE_LIMIT_RESEND_VERIFICATION_MAX = '1000';

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Redis } from 'ioredis';
import { io as socketIo, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisIoAdapter } from '../src/realtime/redis-io.adapter';

const RUN_ID = Date.now().toString(36);
const EMAIL_PREFIX = `e2e-wa-${RUN_ID}`;
const PASSWORD = 'e2e-password-123';
const WORKER_DIST = resolve(__dirname, '../../whatsapp-worker/dist/main.js');

function email(tag: string): string {
  return `${EMAIL_PREFIX}-${tag}@e2e.whauto.test`;
}

function tokenFromDevLink(devLink: string): string {
  const token = new URL(devLink).searchParams.get('token');
  if (!token) throw new Error(`Token absent du devLink : ${devLink}`);
  return token;
}

/** Poll générique — le worker traite en asynchrone. */
async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 15000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timeout: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

interface TestUser {
  email: string;
  accessToken: string;
  userId: string;
}

describe('WhatsApp conversationnel (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;
  let apiPort: number;
  let worker: ChildProcess;

  let owner: TestUser;
  let agent: TestUser;
  let outsider: TestUser; // OWNER d'une autre organisation
  let orgId: string;
  let orgBId: string;
  let shopId: string;
  let shop2Id: string;
  let channelId: string;
  let channel2Id: string;

  const CUSTOMER_PHONE = '+237650111222';

  async function verifiedUser(tag: string): Promise<TestUser> {
    const userEmail = email(tag);
    const registerRes = await request(server)
      .post('/api/auth/register')
      .send({ email: userEmail, password: PASSWORD, firstName: 'E2E', lastName: tag })
      .expect(201);
    await request(server)
      .post('/api/auth/verify-email')
      .send({ token: tokenFromDevLink(registerRes.body.devLink) })
      .expect(200);
    const loginRes = await request(server)
      .post('/api/auth/login')
      .send({ email: userEmail, password: PASSWORD })
      .expect(200);
    return { email: userEmail, accessToken: loginRes.body.accessToken, userId: loginRes.body.user.id };
  }

  function authed(user: TestUser) {
    return {
      get: (path: string) => request(server).get(path).set('Authorization', `Bearer ${user.accessToken}`),
      post: (path: string) => request(server).post(path).set('Authorization', `Bearer ${user.accessToken}`),
      patch: (path: string) => request(server).patch(path).set('Authorization', `Bearer ${user.accessToken}`),
      delete: (path: string) => request(server).delete(path).set('Authorization', `Bearer ${user.accessToken}`),
    };
  }

  /** Injecte un message client entrant via l'endpoint mock et attend son traitement. */
  async function simulateInbound(input: {
    channelId: string;
    phone: string;
    text: string;
    displayName?: string;
    externalMessageId?: string;
  }): Promise<{ conversationId: string; messageId: string }> {
    await request(server).post('/api/dev/whatsapp/mock/inbound').send(input).expect(202);
    const message = await waitFor(
      () =>
        input.externalMessageId
          ? prisma.message.findFirst({
              where: { channelId: input.channelId, externalMessageId: input.externalMessageId },
              select: { id: true, conversationId: true },
            })
          : prisma.message.findFirst({
              where: {
                channelId: input.channelId,
                direction: 'INBOUND',
                textContent: input.text,
                contact: { normalizedPhone: input.phone },
              },
              select: { id: true, conversationId: true },
            }),
      `inbound "${input.text}" traité`,
    );
    return { conversationId: message.conversationId, messageId: message.id };
  }

  beforeAll(async () => {
    if (!existsSync(WORKER_DIST)) {
      throw new Error(
        `Worker non buildé (${WORKER_DIST}) — exécuter d'abord: pnpm --filter @whauto/whatsapp-worker build`,
      );
    }

    const redis = new Redis(process.env.REDIS_URL as string);
    await redis.flushdb();
    redis.disconnect();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    // Adapter Redis : indispensable pour recevoir les événements émis par le worker.
    const ioAdapter = new RedisIoAdapter(app, app.get(ConfigService));
    await ioAdapter.connectToRedis();
    app.useWebSocketAdapter(ioAdapter);
    await app.init();
    await app.listen(0);
    apiPort = (app.getHttpServer().address() as { port: number }).port;
    prisma = app.get(PrismaService);
    server = app.getHttpServer();

    // Worker RÉEL en process enfant, avec délais de test courts.
    worker = spawn(process.execPath, [WORKER_DIST], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        LOG_LEVEL: 'fatal',
        REDIS_URL: 'redis://localhost:6379/1',
        WHATSAPP_JOB_ATTEMPTS: '2',
        WHATSAPP_JOB_BACKOFF_MS: '200',
        WHATSAPP_MOCK_DELIVERY_DELAY_MS: '150',
        WHATSAPP_MOCK_READ_DELAY_MS: '150',
        WHATSAPP_RECOVERY_SWEEP_INTERVAL_MS: '1000',
        WHATSAPP_RECOVERY_STALENESS_MS: '300',
      },
      stdio: 'ignore',
    });

    owner = await verifiedUser('owner');
    agent = await verifiedUser('agent');
    outsider = await verifiedUser('outsider');

    // Organisation A : owner + agent ; deux shops.
    const orgRes = await authed(owner)
      .post('/api/organizations')
      .send({ name: `WA Org ${RUN_ID}`, slug: `e2e-wa-org-${RUN_ID}` })
      .expect(201);
    orgId = orgRes.body.organization.id;

    const inviteRes = await authed(owner)
      .post(`/api/organizations/${orgId}/invitations`)
      .send({ email: agent.email, role: 'AGENT' })
      .expect(201);
    await authed(agent)
      .post('/api/invitations/accept')
      .send({ token: tokenFromDevLink(inviteRes.body.devLink) })
      .expect(200);

    const shopRes = await authed(owner)
      .post(`/api/organizations/${orgId}/shops`)
      .send({ name: `WA Shop ${RUN_ID}`, countryCode: 'CM' })
      .expect(201);
    shopId = shopRes.body.id;
    const shop2Res = await authed(owner)
      .post(`/api/organizations/${orgId}/shops`)
      .send({ name: `WA Shop 2 ${RUN_ID}`, countryCode: 'CM' })
      .expect(201);
    shop2Id = shop2Res.body.id;

    // Organisation B (isolation).
    const orgBRes = await authed(outsider)
      .post('/api/organizations')
      .send({ name: `WA Org B ${RUN_ID}`, slug: `e2e-wa-orgb-${RUN_ID}` })
      .expect(201);
    orgBId = orgBRes.body.organization.id;
  }, 120000);

  afterAll(async () => {
    worker?.kill();
    await app?.close();
  });

  // ------------------------------------------------------------- Channels

  describe('Channels', () => {
    it('AGENT ne peut pas connecter un canal (403)', async () => {
      await authed(agent)
        .post(`/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/mock`)
        .send({ displayName: 'X', phoneNumber: '+237650000001' })
        .expect(403);
    });

    it('connexion d’un canal MOCK (OWNER) → CONNECTED, sans aucun secret', async () => {
      const res = await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/mock`)
        .send({ displayName: 'Boutique WA', phoneNumber: '+237 650 00 00 01' })
        .expect(201);
      channelId = res.body.id;
      expect(res.body.status).toBe('CONNECTED');
      expect(res.body.provider).toBe('MOCK');
      expect(res.body.phoneNumber).toBe('+237650000001');
      expect(res.body.accessTokenEncrypted).toBeUndefined();
      expect(res.body.webhookSecretEncrypted).toBeUndefined();

      const audit = await prisma.organizationAuditEvent.findFirst({
        where: { organizationId: orgId, eventType: 'WHATSAPP_CHANNEL_CONNECTED' },
      });
      expect(audit).not.toBeNull();
    });

    it('un seul canal actif par Shop (409)', async () => {
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/mock`)
        .send({ displayName: 'Doublon', phoneNumber: '+237650000002' })
        .expect(409);
    });

    it('Shop archivée refusée', async () => {
      const tmpShop = await authed(owner)
        .post(`/api/organizations/${orgId}/shops`)
        .send({ name: `WA Tmp ${RUN_ID}`, countryCode: 'CM' })
        .expect(201);
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${tmpShop.body.id}/archive`)
        .expect(200);
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${tmpShop.body.id}/whatsapp-channel/mock`)
        .send({ displayName: 'Archivée', phoneNumber: '+237650000003' })
        .expect(403);
    });

    it('un canal ERROR n’occupe pas le slot : remplacement direct possible', async () => {
      const tmpShop = await authed(owner)
        .post(`/api/organizations/${orgId}/shops`)
        .send({ name: `WA Err ${RUN_ID}`, countryCode: 'CM' })
        .expect(201);
      const created = await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${tmpShop.body.id}/whatsapp-channel/mock`)
        .send({ displayName: 'Err', phoneNumber: '+237650000004' })
        .expect(201);
      // Panne simulée directement en base (aucune API ne produit ERROR en mock).
      await prisma.whatsAppChannel.update({
        where: { id: created.body.id },
        data: { status: 'ERROR', lastErrorCode: 'E2E' },
      });
      // GET renvoie le canal en erreur (l'UI doit pouvoir l'afficher).
      const got = await authed(owner)
        .get(`/api/organizations/${orgId}/shops/${tmpShop.body.id}/whatsapp-channel`)
        .expect(200);
      expect(got.body.status).toBe('ERROR');
      // Nouveau canal accepté SANS déconnexion préalable ; l'ancien est clos.
      const replaced = await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${tmpShop.body.id}/whatsapp-channel/mock`)
        .send({ displayName: 'Remplacé', phoneNumber: '+237650000005' })
        .expect(201);
      expect(replaced.body.status).toBe('CONNECTED');
      const old = await prisma.whatsAppChannel.findUnique({ where: { id: created.body.id } });
      expect(old?.status).toBe('DISCONNECTED');
    });

    it('contrainte DB : un canal ne peut pas référencer la Shop d’une autre organisation (écriture SQL directe)', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO "whatsapp_channels" ("id", "organizationId", "shopId", "provider", "status", "displayName", "phoneNumber", "updatedAt")
          VALUES ('e2e-cross-tenant', ${orgBId}, ${shopId}, 'MOCK', 'DISCONNECTED', 'Cross', '+237650000009', NOW())
        `,
      ).rejects.toThrow(/foreign key|Foreign key/i);
    });
  });

  // ------------------------------------------------------------- Inbound

  describe('Inbound durable', () => {
    it('inbound crée Contact + Conversation + Message + fenêtre 24 h + unreadCount', async () => {
      const { conversationId } = await simulateInbound({
        channelId,
        phone: CUSTOMER_PHONE,
        displayName: 'Client Un',
        text: 'Bonjour, je cherche des chaussures',
      });

      const conversation = await authed(owner)
        .get(`/api/organizations/${orgId}/conversations/${conversationId}`)
        .expect(200);
      expect(conversation.body.status).toBe('OPEN');
      expect(conversation.body.unreadCount).toBe(1);
      expect(conversation.body.contact.displayName).toBe('Client Un');
      expect(conversation.body.customerServiceWindowExpiresAt).not.toBeNull();
      expect(conversation.body.lastMessage.textContent).toBe('Bonjour, je cherche des chaussures');

      const inboundEvent = await prisma.whatsAppInboundEvent.findFirst({
        where: { channelId, status: 'PROCESSED' },
      });
      expect(inboundEvent).not.toBeNull();
    });

    it('le même inbound livré deux fois reste unique (ni message, ni conversation, ni contact dupliqués)', async () => {
      const externalMessageId = `wamid.e2e.${RUN_ID}.dup`;
      const input = {
        channelId,
        phone: CUSTOMER_PHONE,
        text: 'Message relivré',
        externalMessageId,
      };
      await simulateInbound(input);
      await request(server).post('/api/dev/whatsapp/mock/inbound').send(input).expect(202);
      // Laisse le temps à un éventuel double traitement de se produire.
      await new Promise((r) => setTimeout(r, 1500));

      const messages = await prisma.message.count({ where: { channelId, externalMessageId } });
      const contacts = await prisma.contact.count({
        where: { shopId, normalizedPhone: CUSTOMER_PHONE },
      });
      const activeConversations = await prisma.conversation.count({
        where: { channelId, status: { in: ['OPEN', 'PENDING'] } },
      });
      expect(messages).toBe(1);
      expect(contacts).toBe(1);
      expect(activeConversations).toBe(1);
    });

    it('le même numéro dans deux Shops crée deux Contacts distincts', async () => {
      const chan2 = await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shop2Id}/whatsapp-channel/mock`)
        .send({ displayName: 'Shop 2', phoneNumber: '+237650000006' })
        .expect(201);
      channel2Id = chan2.body.id;

      await simulateInbound({ channelId: channel2Id, phone: CUSTOMER_PHONE, text: 'Bonjour shop 2' });

      const contacts = await prisma.contact.findMany({
        where: { organizationId: orgId, normalizedPhone: CUSTOMER_PHONE },
        select: { shopId: true },
      });
      expect(contacts).toHaveLength(2);
      expect(new Set(contacts.map((c) => c.shopId))).toEqual(new Set([shopId, shop2Id]));
    });

    it('un webhook ancien ne réduit JAMAIS la fenêtre 24 h', async () => {
      const conversation = await prisma.conversation.findFirstOrThrow({
        where: { channelId, status: { in: ['OPEN', 'PENDING'] } },
      });
      const windowBefore = conversation.customerServiceWindowExpiresAt!;

      // Événement daté d'il y a 20 h, injecté DIRECTEMENT dans la durable
      // inbox (l'endpoint mock met toujours now) — le sweep le traite.
      await prisma.whatsAppInboundEvent.create({
        data: {
          organizationId: orgId,
          channelId,
          externalEventId: `msg:wamid.e2e.${RUN_ID}.old`,
          eventKind: 'message',
          payload: {
            kind: 'message',
            externalEventId: `msg:wamid.e2e.${RUN_ID}.old`,
            externalMessageId: `wamid.e2e.${RUN_ID}.old`,
            from: CUSTOMER_PHONE,
            text: 'Vieux webhook rejoué',
            providerTimestamp: new Date(Date.now() - 20 * 3600_000).toISOString(),
          },
        },
      });
      await waitFor(
        () =>
          prisma.message.findFirst({
            where: { channelId, externalMessageId: `wamid.e2e.${RUN_ID}.old` },
          }),
        'vieux webhook traité par le sweep',
      );

      const after = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
        select: { customerServiceWindowExpiresAt: true },
      });
      expect(after.customerServiceWindowExpiresAt!.getTime()).toBeGreaterThanOrEqual(
        windowBefore.getTime(),
      );
    });

    it('récupération : un événement RECEIVED jamais publié (panne Redis simulée) est repris par le sweep', async () => {
      // Persisté comme si l'API avait échoué à publier (statut RECEIVED).
      await prisma.whatsAppInboundEvent.create({
        data: {
          organizationId: orgId,
          channelId,
          externalEventId: `msg:wamid.e2e.${RUN_ID}.recov`,
          eventKind: 'message',
          payload: {
            kind: 'message',
            externalEventId: `msg:wamid.e2e.${RUN_ID}.recov`,
            externalMessageId: `wamid.e2e.${RUN_ID}.recov`,
            from: CUSTOMER_PHONE,
            text: 'Récupéré après panne',
            providerTimestamp: new Date().toISOString(),
          },
        },
      });

      const message = await waitFor(
        () =>
          prisma.message.findFirst({
            where: { channelId, externalMessageId: `wamid.e2e.${RUN_ID}.recov` },
          }),
        'événement RECEIVED récupéré par le sweep',
      );
      expect(message.textContent).toBe('Récupéré après panne');
    });
  });

  // ------------------------------------------------------------- Isolation

  describe('Isolation', () => {
    it('les conversations sont invisibles depuis une autre organisation (404/anti-énumération)', async () => {
      const conversation = await prisma.conversation.findFirstOrThrow({ where: { channelId } });
      await authed(outsider)
        .get(`/api/organizations/${orgBId}/conversations/${conversation.id}`)
        .expect(404);
      // Et l'organisation A elle-même est introuvable pour l'outsider.
      await authed(outsider).get(`/api/organizations/${orgId}/conversations`).expect(404);
    });

    it('les conversations sont filtrables par Shop (aucune fuite inter-Shops)', async () => {
      const listShop1 = await authed(owner)
        .get(`/api/organizations/${orgId}/conversations?shopId=${shopId}`)
        .expect(200);
      const listShop2 = await authed(owner)
        .get(`/api/organizations/${orgId}/conversations?shopId=${shop2Id}`)
        .expect(200);
      expect(listShop1.body.items.every((c: { shopId: string }) => c.shopId === shopId)).toBe(true);
      expect(listShop2.body.items.every((c: { shopId: string }) => c.shopId === shop2Id)).toBe(true);
      expect(listShop2.body.items.length).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------- Outbound

  describe('Outbound (transactional outbox)', () => {
    let conversationId: string;

    beforeAll(async () => {
      const conversation = await prisma.conversation.findFirstOrThrow({
        where: { channelId, status: { in: ['OPEN', 'PENDING'] } },
      });
      conversationId = conversation.id;
    });

    it('réponse sortante : PENDING → … → READ (statuts simulés), outbox PUBLISHED', async () => {
      const clientMessageId = `e2e-send-${RUN_ID}-1`;
      const res = await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conversationId}/messages`)
        .send({ text: 'Bonjour ! Que puis-je faire pour vous ?', clientMessageId })
        .expect(201);
      expect(['PENDING', 'QUEUED']).toContain(res.body.status);
      const messageId = res.body.id;

      const read = await waitFor(async () => {
        const message = await prisma.message.findUnique({ where: { id: messageId } });
        return message?.status === 'READ' ? message : null;
      }, 'message sortant jusqu’à READ');

      // Transitions complètes : timestamps cohérents et externalMessageId mock.
      expect(read.externalMessageId).toMatch(/^wamid\.mock\./);
      expect(read.sentAt).not.toBeNull();
      expect(read.deliveredAt).not.toBeNull();
      expect(read.readAt).not.toBeNull();
      expect(read.sentAt!.getTime()).toBeLessThanOrEqual(read.deliveredAt!.getTime());
      expect(read.deliveredAt!.getTime()).toBeLessThanOrEqual(read.readAt!.getTime());

      const outbox = await prisma.outboxEvent.findFirst({
        where: { organizationId: orgId, status: 'PUBLISHED' },
      });
      expect(outbox).not.toBeNull();
    });

    it('idempotence frontend : même clientMessageId → même message, aucun doublon', async () => {
      const clientMessageId = `e2e-send-${RUN_ID}-dup`;
      const first = await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conversationId}/messages`)
        .send({ text: 'Retry réseau', clientMessageId })
        .expect(201);
      const second = await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conversationId}/messages`)
        .send({ text: 'Retry réseau', clientMessageId })
        .expect(201);
      expect(second.body.id).toBe(first.body.id);
      const count = await prisma.message.count({ where: { conversationId, clientMessageId } });
      expect(count).toBe(1);
    });

    it('échec simulé (!fail) : FAILED après épuisement, puis retry explicite réussit', async () => {
      const clientMessageId = `e2e-send-${RUN_ID}-fail`;
      const res = await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conversationId}/messages`)
        .send({ text: '!fail cet envoi doit échouer', clientMessageId })
        .expect(201);
      const messageId = res.body.id;

      const failed = await waitFor(async () => {
        const message = await prisma.message.findUnique({ where: { id: messageId } });
        return message?.status === 'FAILED' ? message : null;
      }, 'message !fail jusqu’à FAILED');
      expect(failed.errorCode).toBe('MOCK_SIMULATED_FAILURE');
      expect(failed.attemptCount).toBeGreaterThanOrEqual(2); // retries BullMQ tracés

      // Réparation (texte corrigé) puis retry explicite : FAILED → PENDING → READ.
      await prisma.message.update({ where: { id: messageId }, data: { textContent: 'Corrigé' } });
      const retryRes = await authed(owner)
        .post(
          `/api/organizations/${orgId}/conversations/${conversationId}/messages/${messageId}/retry`,
        )
        .expect(200);
      expect(retryRes.body.status).toBe('PENDING');

      await waitFor(async () => {
        const message = await prisma.message.findUnique({ where: { id: messageId } });
        return message?.status === 'READ' ? message : null;
      }, 'message retenté jusqu’à READ');
    });

    it('un message non-FAILED ne peut pas être retenté (409)', async () => {
      const message = await prisma.message.findFirstOrThrow({
        where: { conversationId, status: 'READ', direction: 'OUTBOUND' },
      });
      await authed(owner)
        .post(
          `/api/organizations/${orgId}/conversations/${conversationId}/messages/${message.id}/retry`,
        )
        .expect(409);
    });

    it('récupération : un OutboxEvent PENDING jamais publié est repris par le sweep (publication répétée sans double envoi)', async () => {
      const conversation = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { shopId: true, channelId: true, contactId: true },
      });
      const dispatchId = `e2e-recov-${RUN_ID}`;
      // Message PENDING + outbox PENDING créés comme si l'API était morte
      // juste après le commit (publication jamais tentée).
      const message = await prisma.message.create({
        data: {
          organizationId: orgId,
          shopId: conversation.shopId,
          conversationId,
          channelId: conversation.channelId,
          contactId: conversation.contactId,
          direction: 'OUTBOUND',
          type: 'TEXT',
          status: 'PENDING',
          senderType: 'AGENT',
          textContent: 'Envoyé après reprise',
          dispatchId,
        },
      });
      await prisma.outboxEvent.create({
        data: {
          organizationId: orgId,
          eventType: 'WHATSAPP_MESSAGE_SEND_REQUESTED',
          payload: { messageId: message.id, dispatchId },
        },
      });

      const sent = await waitFor(async () => {
        const row = await prisma.message.findUnique({ where: { id: message.id } });
        return row && ['SENT', 'DELIVERED', 'READ'].includes(row.status) ? row : null;
      }, 'outbox PENDING repris par le sweep');
      expect(sent.externalMessageId).toMatch(/^wamid\.mock\./);
      // Un seul envoi logique : attemptCount = 1 malgré d'éventuelles republications.
      expect(sent.attemptCount).toBe(1);
    });

    it('fenêtre 24 h expirée : envoi refusé avec CUSTOMER_SERVICE_WINDOW_EXPIRED', async () => {
      // Nouvelle conversation dédiée sur le canal du shop 2.
      const { conversationId: conv2 } = await simulateInbound({
        channelId: channel2Id,
        phone: '+237650333444',
        text: 'Test fenêtre',
      });
      await prisma.conversation.update({
        where: { id: conv2 },
        data: { customerServiceWindowExpiresAt: new Date(Date.now() - 1000) },
      });
      const res = await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conv2}/messages`)
        .send({ text: 'Trop tard', clientMessageId: `e2e-window-${RUN_ID}` })
        .expect(422);
      expect(res.body.code).toBe('CUSTOMER_SERVICE_WINDOW_EXPIRED');
    });
  });

  // ------------------------------------------------------------- Conversation lifecycle

  describe('Notes, assignation, statuts, lecture, tags', () => {
    let conversationId: string;
    let agentMembershipId: string;

    beforeAll(async () => {
      const conversation = await prisma.conversation.findFirstOrThrow({
        where: { channelId, status: { in: ['OPEN', 'PENDING'] } },
      });
      conversationId = conversation.id;
      const membership = await prisma.membership.findFirstOrThrow({
        where: { organizationId: orgId, role: 'AGENT' },
      });
      agentMembershipId = membership.id;
    });

    it('note interne : jamais envoyée au provider, unreadCount inchangé', async () => {
      const before = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { unreadCount: true, lastMessageAt: true },
      });
      const outboxBefore = await prisma.outboxEvent.count({ where: { organizationId: orgId } });

      const res = await authed(agent)
        .post(`/api/organizations/${orgId}/conversations/${conversationId}/notes`)
        .send({ text: 'Client fidèle, offrir une remise' })
        .expect(201);
      expect(res.body.direction).toBe('INTERNAL');
      expect(res.body.type).toBe('INTERNAL_NOTE');
      expect(res.body.status).toBe('RECEIVED');

      await new Promise((r) => setTimeout(r, 800));
      const note = await prisma.message.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(note.status).toBe('RECEIVED'); // jamais passée par la file d'envoi
      expect(note.externalMessageId).toBeNull(); // jamais transmise au provider

      const after = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { unreadCount: true },
      });
      expect(after.unreadCount).toBe(before.unreadCount);
      const outboxAfter = await prisma.outboxEvent.count({ where: { organizationId: orgId } });
      expect(outboxAfter).toBe(outboxBefore); // aucun événement d'envoi créé
    });

    it('assignation à un membre ACTIVE + audit', async () => {
      const res = await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conversationId}/assign`)
        .send({ membershipId: agentMembershipId })
        .expect(200);
      expect(res.body.assignedMembership.id).toBe(agentMembershipId);
      const audit = await prisma.organizationAuditEvent.findFirst({
        where: { organizationId: orgId, eventType: 'CONVERSATION_ASSIGNED' },
      });
      expect(audit).not.toBeNull();
    });

    it('assignation à un membership externe refusée (404 anti-énumération)', async () => {
      const outsiderMembership = await prisma.membership.findFirstOrThrow({
        where: { organizationId: orgBId },
      });
      await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conversationId}/assign`)
        .send({ membershipId: outsiderMembership.id })
        .expect(404);
    });

    it('assignation à un membership LEFT/SUSPENDED refusée (409)', async () => {
      // SUSPENDED simulé directement (aucune API de suspension n'existe encore).
      await prisma.membership.update({
        where: { id: agentMembershipId },
        data: { status: 'SUSPENDED' },
      });
      await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conversationId}/assign`)
        .send({ membershipId: agentMembershipId })
        .expect(409);
      await prisma.membership.update({
        where: { id: agentMembershipId },
        data: { status: 'ACTIVE' },
      });
    });

    it('marquer lu : unreadCount → 0 (idempotent)', async () => {
      const res = await authed(agent)
        .post(`/api/organizations/${orgId}/conversations/${conversationId}/read`)
        .expect(200);
      expect(res.body.unreadCount).toBe(0);
      await authed(agent)
        .post(`/api/organizations/${orgId}/conversations/${conversationId}/read`)
        .expect(200);
    });

    it('transitions de statut : OPEN → RESOLVED → OPEN (réouverture) → CLOSED terminal', async () => {
      await authed(agent)
        .patch(`/api/organizations/${orgId}/conversations/${conversationId}/status`)
        .send({ status: 'RESOLVED' })
        .expect(200);
      // Réouverture manuelle possible (aucune autre conversation active).
      await authed(agent)
        .patch(`/api/organizations/${orgId}/conversations/${conversationId}/status`)
        .send({ status: 'OPEN' })
        .expect(200);
      await authed(agent)
        .patch(`/api/organizations/${orgId}/conversations/${conversationId}/status`)
        .send({ status: 'CLOSED' })
        .expect(200);
      // CLOSED est terminal.
      await authed(agent)
        .patch(`/api/organizations/${orgId}/conversations/${conversationId}/status`)
        .send({ status: 'OPEN' })
        .expect(409);
    });

    it('un inbound après CLOSED crée une NOUVELLE conversation (jamais de réouverture auto)', async () => {
      const { conversationId: newConvId } = await simulateInbound({
        channelId,
        phone: CUSTOMER_PHONE,
        text: 'Je reviens vers vous',
        externalMessageId: `wamid.e2e.${RUN_ID}.reopen`,
      });
      expect(newConvId).not.toBe(conversationId);
      const newConv = await prisma.conversation.findUniqueOrThrow({ where: { id: newConvId } });
      expect(newConv.status).toBe('OPEN');
    });

    it('tags : ajout (créé dans l’org), filtrage, retrait — tenant-scopés', async () => {
      const conversation = await prisma.conversation.findFirstOrThrow({
        where: { channelId, status: 'OPEN' },
      });
      const tagged = await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conversation.id}/tags`)
        .send({ name: 'VIP' })
        .expect(200);
      const tagId = tagged.body.tags.find((t: { name: string }) => t.name === 'VIP').id;

      const filtered = await authed(owner)
        .get(`/api/organizations/${orgId}/conversations?tagIds=${tagId}`)
        .expect(200);
      expect(filtered.body.items.some((c: { id: string }) => c.id === conversation.id)).toBe(true);

      // Un tag d'une autre organisation est introuvable (404).
      const foreignTag = await prisma.tag.create({
        data: { organizationId: orgBId, name: `foreign-${RUN_ID}` },
      });
      await authed(owner)
        .delete(`/api/organizations/${orgId}/conversations/${conversation.id}/tags/${foreignTag.id}`)
        .expect(404);

      const removed = await authed(owner)
        .delete(`/api/organizations/${orgId}/conversations/${conversation.id}/tags/${tagId}`)
        .expect(200);
      expect(removed.body.tags).toHaveLength(0);
    });

    it('cursor pagination : pas de doublon ni de trou entre pages', async () => {
      const page1 = await authed(owner)
        .get(`/api/organizations/${orgId}/conversations?limit=2`)
        .expect(200);
      expect(page1.body.items.length).toBeLessThanOrEqual(2);
      if (page1.body.nextCursor) {
        const page2 = await authed(owner)
          .get(
            `/api/organizations/${orgId}/conversations?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
          )
          .expect(200);
        const ids1 = new Set(page1.body.items.map((c: { id: string }) => c.id));
        for (const item of page2.body.items) {
          expect(ids1.has(item.id)).toBe(false);
        }
      }
    });

    it('filtres : status, unreadOnly, recherche contact', async () => {
      const open = await authed(owner)
        .get(`/api/organizations/${orgId}/conversations?status=OPEN`)
        .expect(200);
      expect(open.body.items.every((c: { status: string }) => c.status === 'OPEN')).toBe(true);

      const unread = await authed(owner)
        .get(`/api/organizations/${orgId}/conversations?unreadOnly=true`)
        .expect(200);
      expect(unread.body.items.every((c: { unreadCount: number }) => c.unreadCount > 0)).toBe(true);

      const searched = await authed(owner)
        .get(`/api/organizations/${orgId}/conversations?search=650111`)
        .expect(200);
      expect(searched.body.items.length).toBeGreaterThan(0);
    });

    it('permissions AGENT : reply/status/note OK ; assign, tags et contacts.update 403', async () => {
      const conversation = await prisma.conversation.findFirstOrThrow({
        where: { channelId, status: 'OPEN' },
      });
      await authed(agent)
        .post(`/api/organizations/${orgId}/conversations/${conversation.id}/messages`)
        .send({ text: 'Réponse AGENT', clientMessageId: `e2e-agent-${RUN_ID}` })
        .expect(201);
      await authed(agent)
        .post(`/api/organizations/${orgId}/conversations/${conversation.id}/assign`)
        .send({ membershipId: agentMembershipId })
        .expect(403);
      await authed(agent)
        .post(`/api/organizations/${orgId}/conversations/${conversation.id}/tags`)
        .send({ name: 'interdit' })
        .expect(403);
      const contact = await prisma.contact.findFirstOrThrow({ where: { shopId } });
      await authed(agent)
        .patch(`/api/organizations/${orgId}/contacts/${contact.id}`)
        .send({ displayName: 'interdit' })
        .expect(403);
    });
  });

  // ------------------------------------------------------------- Socket.IO

  describe('Socket.IO', () => {
    function connectSocket(token: string): Promise<ClientSocket> {
      return new Promise((resolvePromise, reject) => {
        const socket = socketIo(`http://localhost:${apiPort}`, {
          auth: { token },
          transports: ['websocket'],
          reconnection: false,
        });
        socket.on('connect', () => resolvePromise(socket));
        socket.on('connect_error', reject);
        setTimeout(() => reject(new Error('socket connect timeout')), 5000);
      });
    }

    function subscribeOrg(socket: ClientSocket, organizationId: string): Promise<{ ok: boolean }> {
      return socket.emitWithAck('subscribe:organization', { organizationId }) as Promise<{
        ok: boolean;
      }>;
    }

    it('un token invalide est déconnecté immédiatement', async () => {
      const socket = socketIo(`http://localhost:${apiPort}`, {
        auth: { token: 'invalid-token' },
        transports: ['websocket'],
        reconnection: false,
      });
      await new Promise<void>((resolvePromise, reject) => {
        socket.on('disconnect', () => resolvePromise());
        socket.on('connect_error', () => resolvePromise());
        setTimeout(() => reject(new Error('jamais déconnecté')), 5000);
      });
      socket.close();
    });

    it('le join de room revalide le Membership en base (jamais de confiance au nom demandé)', async () => {
      const socket = await connectSocket(outsider.accessToken);
      const denied = await subscribeOrg(socket, orgId); // pas membre de l'org A
      expect(denied.ok).toBe(false);
      const granted = await subscribeOrg(socket, orgBId); // membre de l'org B
      expect(granted.ok).toBe(true);
      socket.close();
    });

    it('les événements ne sortent JAMAIS de l’organisation : un inbound org A n’atteint pas l’org B', async () => {
      const socketA = await connectSocket(owner.accessToken);
      const socketB = await connectSocket(outsider.accessToken);
      expect((await subscribeOrg(socketA, orgId)).ok).toBe(true);
      expect((await subscribeOrg(socketB, orgBId)).ok).toBe(true);

      const receivedA: unknown[] = [];
      const receivedB: unknown[] = [];
      socketA.on('message.created', (payload) => receivedA.push(payload));
      socketB.on('message.created', (payload) => receivedB.push(payload));

      await simulateInbound({
        channelId,
        phone: CUSTOMER_PHONE,
        text: 'Événement temps réel',
        externalMessageId: `wamid.e2e.${RUN_ID}.socket`,
      });
      // L'événement worker → redis-emitter → API arrive de façon asynchrone.
      await waitFor(
        () => Promise.resolve(receivedA.length > 0 ? receivedA : null),
        'événement socket reçu par org A',
      );
      await new Promise((r) => setTimeout(r, 500));

      expect(receivedA.length).toBeGreaterThan(0);
      expect(receivedB).toHaveLength(0);
      expect((receivedA[0] as { message: { textContent: string } }).message.textContent).toBe(
        'Événement temps réel',
      );

      socketA.close();
      socketB.close();
    });

    it('un membre retiré est évincé immédiatement (membership.revoked + sortie de room)', async () => {
      // Nouveau membre jetable dans l'org A.
      const evictee = await verifiedUser('evictee');
      const inviteRes = await authed(owner)
        .post(`/api/organizations/${orgId}/invitations`)
        .send({ email: evictee.email, role: 'AGENT' })
        .expect(201);
      await authed(evictee)
        .post('/api/invitations/accept')
        .send({ token: tokenFromDevLink(inviteRes.body.devLink) })
        .expect(200);

      const socket = await connectSocket(evictee.accessToken);
      expect((await subscribeOrg(socket, orgId)).ok).toBe(true);

      const revoked = new Promise<{ organizationId: string }>((resolvePromise) =>
        socket.on('membership.revoked', resolvePromise),
      );
      const orgEvents: unknown[] = [];
      socket.on('message.created', (payload) => orgEvents.push(payload));

      const membership = await prisma.membership.findFirstOrThrow({
        where: { organizationId: orgId, user: { email: evictee.email } },
      });
      await authed(owner)
        .delete(`/api/organizations/${orgId}/members/${membership.id}`)
        .expect(204);

      expect((await revoked).organizationId).toBe(orgId);

      // Après éviction, un nouvel inbound org A ne lui parvient plus.
      await simulateInbound({
        channelId,
        phone: CUSTOMER_PHONE,
        text: 'Après éviction',
        externalMessageId: `wamid.e2e.${RUN_ID}.evicted`,
      });
      await new Promise((r) => setTimeout(r, 1200));
      expect(orgEvents).toHaveLength(0);
      socket.close();
    });
  });
});
