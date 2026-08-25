// Overrides d'environnement AVANT l'import d'AppModule. Secrets de TEST
// uniquement (jamais de vraie clé). Le faux serveur Graph est démarré plus bas
// et son URL est injectée via META_GRAPH_API_BASE_URL.
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.AUTH_EXPOSE_TEST_TOKENS = 'true';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.META_APP_SECRET = 'test-app-secret';
process.env.META_APP_ID = 'test-app-id';
process.env.META_ACCESS_TOKEN = 'test-access-token';
process.env.META_PHONE_NUMBER_ID = 'TEST_PN_1';
process.env.META_WABA_ID = 'TEST_WABA_1';
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-verify-token';
process.env.META_GRAPH_API_VERSION = 'v21.0';
// Faux serveur Graph sur un port FIXE, connu AVANT l'import statique d'AppModule
// (Jest CJS n'autorise pas l'import() dynamique).
const GRAPH_PORT = 4799;
process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${GRAPH_PORT}`;
process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REGISTER_MAX = '1000';

import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Redis } from 'ioredis';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';
const PHONE_NUMBER_ID = 'TEST_PN_1';
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'e2e-password-123';
const WORKER_DIST = resolve(__dirname, '../../whatsapp-worker/dist/main.js');

/** Faux serveur Graph : exerce le VRAI provider Meta (URL, en-têtes, payload, erreurs). */
interface GraphRequest {
  method: string;
  url: string;
  authorization?: string;
  body: unknown;
}

class FakeGraphServer {
  server!: Server;
  requests: GraphRequest[] = [];
  /** Texte déclencheur d'une erreur simulée (mapping d'erreur). */
  failOnText?: string;
  private counter = 0;

  async start(port: number): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(port, r));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = undefined;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      this.requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers['authorization'] as string | undefined,
        body,
      });

      // GET /{version}/{phoneNumberId}?fields=... → validateConfiguration.
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: PHONE_NUMBER_ID,
            display_phone_number: '+1 555 010 0001',
            verified_name: 'Whauto Test Store',
          }),
        );
        return;
      }

      // POST .../messages → envoi.
      const text = (body as { text?: { body?: string } })?.text?.body;
      if (this.failOnText !== undefined && text === this.failOnText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 100, message: 'Invalid parameter', type: 'OAuthException' } }));
        return;
      }
      this.counter += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.SENT.${this.counter}` }] }));
    });
  }

  postMessagesCount(): number {
    return this.requests.filter((r) => r.method === 'POST' && r.url.includes('/messages')).length;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  // Marge large : le worker (process enfant) peut mettre plusieurs secondes à
  // booter + consommer sous charge machine ; les événements sont traités mais
  // parfois tardivement (durable inbox → jamais perdus).
  timeoutMs = 30000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function sign(raw: string, secret = APP_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
}

function inboundWebhook(opts: {
  phoneNumberId?: string;
  from: string;
  messageId: string;
  text?: string;
  type?: string;
  name?: string;
  caption?: string;
  mimeType?: string;
  fileName?: string;
}): string {
  const type = opts.type ?? 'text';
  const message: Record<string, unknown> = {
    from: opts.from,
    id: opts.messageId,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type,
  };
  if (type === 'text') {
    message.text = { body: opts.text ?? 'Bonjour' };
  } else {
    message[type] = {
      id: `MEDIA_${opts.messageId}`,
      ...(opts.mimeType ? { mime_type: opts.mimeType } : {}),
      ...(opts.fileName ? { filename: opts.fileName } : {}),
      ...(opts.caption ? { caption: opts.caption } : {}),
    };
  }
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550', phone_number_id: opts.phoneNumberId ?? PHONE_NUMBER_ID },
              contacts: opts.name ? [{ wa_id: opts.from, profile: { name: opts.name } }] : undefined,
              messages: [message],
            },
          },
        ],
      },
    ],
  });
}

function statusWebhook(opts: { messageId: string; status: string; recipient: string }): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              statuses: [
                {
                  id: opts.messageId,
                  status: opts.status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: opts.recipient,
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

interface TestUser {
  email: string;
  accessToken: string;
}

describe('Meta WhatsApp Cloud (e2e, faux Graph)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;
  let worker: ChildProcess;
  const graph = new FakeGraphServer();

  let owner: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let orgBId: string;
  let shopId: string;
  let channelId: string;

  const CUSTOMER = '237650111222';

  async function verifiedUser(tag: string): Promise<TestUser> {
    const email = `e2e-meta-${RUN_ID}-${tag}@e2e.whauto.test`;
    const reg = await request(server)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, firstName: 'E2E', lastName: tag })
      .expect(201);
    await request(server)
      .post('/api/auth/verify-email')
      .send({ token: new URL(reg.body.devLink).searchParams.get('token') })
      .expect(200);
    const login = await request(server).post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
    return { email, accessToken: login.body.accessToken };
  }

  function authed(user: TestUser, method: 'get' | 'post', path: string) {
    return request(server)[method](path).set('Authorization', `Bearer ${user.accessToken}`);
  }

  function postWebhook(raw: string, signature: string | undefined) {
    const req = request(server).post('/api/webhooks/whatsapp/meta').set('Content-Type', 'application/json');
    if (signature !== undefined) {
      req.set('x-hub-signature-256', signature);
    }
    return req.send(raw);
  }

  beforeAll(async () => {
    if (!existsSync(WORKER_DIST)) {
      throw new Error('Worker non buildé — pnpm --filter @whauto/whatsapp-worker build');
    }
    await graph.start(GRAPH_PORT);

    const redis = new Redis(process.env.REDIS_URL as string);
    await redis.flushdb();
    redis.disconnect();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    server = app.getHttpServer();

    // Le phone_number_id de test est FIXE : un run interrompu avant son nettoyage
    // laisse un canal CONNECTED qui porte le même numéro. Le webhook résout le
    // canal le plus ANCIEN pour un numéro donné — les événements de ce run
    // partiraient alors vers un canal mort, et tous les scénarios worker
    // échoueraient en timeout sans erreur visible. On neutralise donc les
    // canaux résiduels avant de connecter le nôtre (aucune suppression).
    await prisma.whatsAppChannel.updateMany({
      where: {
        provider: 'META_CLOUD',
        phoneNumberId: PHONE_NUMBER_ID,
        status: { in: ['CONNECTING', 'CONNECTED', 'SUSPENDED'] },
      },
      data: { status: 'DISCONNECTED' },
    });

    // Worker réel : envoi Meta vers le faux Graph, sweep court pour l'orphelin.
    worker = spawn(process.execPath, [WORKER_DIST], {
      env: {
        ...process.env,
        LOG_LEVEL: 'fatal',
        WHATSAPP_RECOVERY_SWEEP_INTERVAL_MS: '1000',
        WHATSAPP_RECOVERY_STALENESS_MS: '500',
        WHATSAPP_ORPHAN_STATUS_TTL_MS: '3000',
      },
      stdio: 'ignore',
    });

    owner = await verifiedUser('owner');
    outsider = await verifiedUser('outsider');

    orgId = (
      await authed(owner, 'post', '/api/organizations')
        .send({ name: `Meta Org ${RUN_ID}`, slug: `e2e-meta-org-${RUN_ID}` })
        .expect(201)
    ).body.organization.id;
    shopId = (
      await authed(owner, 'post', `/api/organizations/${orgId}/shops`)
        .send({ name: `Meta Shop ${RUN_ID}`, countryCode: 'CM' })
        .expect(201)
    ).body.id;

    orgBId = (
      await authed(outsider, 'post', '/api/organizations')
        .send({ name: `Meta Org B ${RUN_ID}`, slug: `e2e-meta-orgb-${RUN_ID}` })
        .expect(201)
    ).body.organization.id;
  }, 180000);

  afterAll(async () => {
    // Attendre la mort effective du worker : évite qu'un worker survivant
    // interfère avec la suite suivante (teardown déterministe).
    if (worker) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        worker.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        worker.kill();
      });
    }
    await app?.close();
    await graph.stop();
  });

  // ------------------------------------------------------------ vérification

  describe('Webhook GET (vérification) et connexion du canal', () => {
    it('challenge renvoyé si verify_token valide', async () => {
      const res = await request(server)
        .get('/api/webhooks/whatsapp/meta')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'CHALLENGE_42' })
        .expect(200);
      expect(res.text).toBe('CHALLENGE_42');
    });

    it('verify_token invalide → 403', async () => {
      await request(server)
        .get('/api/webhooks/whatsapp/meta')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'x' })
        .expect(403);
    });

    it('connexion du canal Meta pilote (Graph GET, aucun envoi)', async () => {
      const before = graph.postMessagesCount();
      const res = await authed(owner, 'post', `/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/meta/connect`)
        .send({})
        .expect(201);
      expect(res.body.provider).toBe('META_CLOUD');
      expect(res.body.status).toBe('CONNECTED');
      expect(res.body.phoneNumberId).toBe(PHONE_NUMBER_ID);
      expect(res.body.verifiedName).toBe('Whauto Test Store');
      expect(res.body).not.toHaveProperty('accessTokenEncrypted');
      channelId = res.body.id;
      // La connexion NE fait AUCUN envoi de message.
      expect(graph.postMessagesCount()).toBe(before);
    });

    it('health : Graph GET uniquement, jamais d’envoi', async () => {
      const before = graph.postMessagesCount();
      const res = await authed(owner, 'get', `/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/meta/health`)
        .expect(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.provider).toBe('META_CLOUD');
      expect(graph.postMessagesCount()).toBe(before);
    });
  });

  // ------------------------------------------------------------ inbound HMAC

  describe('Webhook POST (inbound) — signature et durable inbox', () => {
    it('signature absente → 401 ; signature invalide → 401', async () => {
      const raw = inboundWebhook({ from: CUSTOMER, messageId: 'wamid.NOSIG', text: 'x' });
      await postWebhook(raw, undefined).expect(401);
      await postWebhook(raw, sign(raw, 'wrong-secret')).expect(401);
    });

    it('inbound texte signé → Contact + Conversation + Message créés (via worker)', async () => {
      const raw = inboundWebhook({ from: CUSTOMER, messageId: 'wamid.IN1', text: 'Bonjour', name: 'Awa' });
      await postWebhook(raw, sign(raw)).expect(200);

      const message = await waitFor(
        () =>
          prisma.message.findFirst({
            where: { channelId, externalMessageId: 'wamid.IN1' },
            select: { id: true, type: true, textContent: true, direction: true, conversationId: true },
          }),
        'message inbound IN1',
      );
      expect(message.type).toBe('TEXT');
      expect(message.textContent).toBe('Bonjour');
      expect(message.direction).toBe('INBOUND');

      const contact = await prisma.contact.findFirst({ where: { shopId, normalizedPhone: `+${CUSTOMER}` } });
      expect(contact?.displayName).toBe('Awa');
    });

    it('relivraison du MÊME message.id → aucune duplication', async () => {
      const raw = inboundWebhook({ from: CUSTOMER, messageId: 'wamid.IN1', text: 'Bonjour' });
      await postWebhook(raw, sign(raw)).expect(200);
      await new Promise((r) => setTimeout(r, 500));
      const count = await prisma.message.count({ where: { channelId, externalMessageId: 'wamid.IN1' } });
      expect(count).toBe(1);
    });

    it('média : vrai type conservé (IMAGE), textContent null — jamais converti en texte', async () => {
      const raw = inboundWebhook({ from: CUSTOMER, messageId: 'wamid.IMG1', type: 'image' });
      await postWebhook(raw, sign(raw)).expect(200);
      const message = await waitFor(
        () =>
          prisma.message.findFirst({
            where: { channelId, externalMessageId: 'wamid.IMG1' },
            select: { type: true, textContent: true },
          }),
        'message image',
      );
      expect(message.type).toBe('IMAGE');
      expect(message.textContent).toBeNull();
    });

    it('média : identifiant fournisseur capturé + statut PENDING (le fichier reste récupérable)', async () => {
      const raw = inboundWebhook({
        from: CUSTOMER,
        messageId: 'wamid.IMG2',
        type: 'image',
        mimeType: 'image/jpeg',
      });
      await postWebhook(raw, sign(raw)).expect(200);
      const message = await waitFor(
        () =>
          prisma.message.findFirst({
            where: { channelId, externalMessageId: 'wamid.IMG2' },
            select: {
              type: true,
              externalMediaId: true,
              mediaStatus: true,
              mediaMimeType: true,
              mediaStorageKey: true,
            },
          }),
        'message image avec média',
      );
      // Sans cet identifiant, le fichier serait définitivement irrécupérable.
      expect(message.externalMediaId).toBe('MEDIA_wamid.IMG2');
      expect(message.mediaMimeType).toBe('image/jpeg');
      // Le téléchargement est ASYNCHRONE : rien n'est stocké à l'ingestion.
      expect(message.mediaStatus).toBe('PENDING');
      expect(message.mediaStorageKey).toBeNull();
    });

    it('média légendé : la légende devient le texte du message (question du client conservée)', async () => {
      const raw = inboundWebhook({
        from: CUSTOMER,
        messageId: 'wamid.IMG3',
        type: 'image',
        caption: 'Vous avez ça en 42 ?',
      });
      await postWebhook(raw, sign(raw)).expect(200);
      const message = await waitFor(
        () =>
          prisma.message.findFirst({
            where: { channelId, externalMessageId: 'wamid.IMG3' },
            select: { type: true, textContent: true, externalMediaId: true },
          }),
        'message image légendé',
      );
      expect(message.type).toBe('IMAGE');
      expect(message.textContent).toBe('Vous avez ça en 42 ?');
      expect(message.externalMediaId).toBe('MEDIA_wamid.IMG3');
    });

    it('document : nom de fichier conservé pour l’affichage et le téléchargement', async () => {
      const raw = inboundWebhook({
        from: CUSTOMER,
        messageId: 'wamid.DOC1',
        type: 'document',
        mimeType: 'application/pdf',
        fileName: 'bon-de-commande.pdf',
      });
      await postWebhook(raw, sign(raw)).expect(200);
      const message = await waitFor(
        () =>
          prisma.message.findFirst({
            where: { channelId, externalMessageId: 'wamid.DOC1' },
            select: { type: true, mediaFileName: true, mediaStatus: true },
          }),
        'message document',
      );
      expect(message.type).toBe('DOCUMENT');
      expect(message.mediaFileName).toBe('bon-de-commande.pdf');
      expect(message.mediaStatus).toBe('PENDING');
    });

    it('phone_number_id inconnu + signature valide → ACK 200, AUCUNE écriture métier', async () => {
      const raw = inboundWebhook({ phoneNumberId: 'UNKNOWN_PN', from: '237650999888', messageId: 'wamid.UNK1', text: 'x' });
      await postWebhook(raw, sign(raw)).expect(200);
      await new Promise((r) => setTimeout(r, 700));
      const message = await prisma.message.findFirst({ where: { externalMessageId: 'wamid.UNK1' } });
      expect(message).toBeNull();
      const inboundEvent = await prisma.whatsAppInboundEvent.findFirst({
        where: { externalEventId: 'wamid.UNK1' },
      });
      expect(inboundEvent).toBeNull(); // rien persisté.
    });
  });

  // ------------------------------------------------------------ outbound

  describe('Réponse humaine → outbox → Meta (faux Graph) → statuts', () => {
    let conversationId: string;
    let outboundMessageId: string;
    let providerMessageId: string;

    beforeAll(async () => {
      const conv = await waitFor(
        () =>
          prisma.conversation.findFirst({
            where: { channelId, contact: { normalizedPhone: `+${CUSTOMER}` } },
            select: { id: true },
          }),
        'conversation client',
      );
      conversationId = conv.id;
    });

    it('envoi humain : Message SENT avec providerMessageId du faux Graph', async () => {
      const before = graph.postMessagesCount();
      const res = await authed(
        owner,
        'post',
        `/api/organizations/${orgId}/conversations/${conversationId}/messages`,
      )
        .send({ text: 'Bonjour, comment puis-je aider ?', clientMessageId: `cm-${RUN_ID}-1` })
        .expect(201);
      outboundMessageId = res.body.id;

      const sent = await waitFor(
        () =>
          prisma.message
            .findUnique({
              where: { id: outboundMessageId },
              select: { status: true, externalMessageId: true },
            })
            .then((m) => (m && m.status === 'SENT' ? m : null)),
        'message SENT',
      );
      expect(sent.externalMessageId).toMatch(/^wamid\.SENT\./);
      providerMessageId = sent.externalMessageId as string;
      expect(graph.postMessagesCount()).toBe(before + 1);

      // Le vrai provider a appelé le bon endpoint avec le token en Bearer.
      const call = graph.requests.filter((r) => r.method === 'POST').at(-1);
      expect(call?.url).toContain(`/${PHONE_NUMBER_ID}/messages`);
      expect(call?.authorization).toBe('Bearer test-access-token');
    });

    it('statuts DELIVERED puis READ appliqués (transitions monotones)', async () => {
      const delivered = statusWebhook({ messageId: providerMessageId, status: 'delivered', recipient: CUSTOMER });
      await postWebhook(delivered, sign(delivered)).expect(200);
      await waitFor(
        () =>
          prisma.message
            .findUnique({ where: { id: outboundMessageId }, select: { status: true } })
            .then((m) => (m?.status === 'DELIVERED' ? m : null)),
        'DELIVERED',
      );

      const read = statusWebhook({ messageId: providerMessageId, status: 'read', recipient: CUSTOMER });
      await postWebhook(read, sign(read)).expect(200);
      const final = await waitFor(
        () =>
          prisma.message
            .findUnique({ where: { id: outboundMessageId }, select: { status: true, deliveredAt: true, readAt: true } })
            .then((m) => (m?.status === 'READ' ? m : null)),
        'READ',
      );
      expect(final.deliveredAt).not.toBeNull(); // backfill préservé.
    });

    it('erreur Meta définitive → Message FAILED avec code mappé', async () => {
      graph.failOnText = '!graphfail';
      const res = await authed(
        owner,
        'post',
        `/api/organizations/${orgId}/conversations/${conversationId}/messages`,
      )
        .send({ text: '!graphfail', clientMessageId: `cm-${RUN_ID}-fail` })
        .expect(201);
      const failed = await waitFor(
        () =>
          prisma.message
            .findUnique({ where: { id: res.body.id }, select: { status: true, errorCode: true } })
            .then((m) => (m?.status === 'FAILED' ? m : null)),
        'message FAILED',
      );
      expect(failed.errorCode).toMatch(/^META_/);
      graph.failOnText = undefined;
    });
  });

  // ------------------------------------------------------------ orphelins

  describe('Statuts orphelins (WAITING_MESSAGE → réconcilié / ORPHANED)', () => {
    it('statut pour un message inconnu → WAITING_MESSAGE, puis PROCESSED après arrivée du Message', async () => {
      const raw = statusWebhook({ messageId: 'wamid.ORPHAN1', status: 'delivered', recipient: CUSTOMER });
      await postWebhook(raw, sign(raw)).expect(200);

      const waiting = await waitFor(
        () =>
          prisma.whatsAppInboundEvent
            .findFirst({
              where: { channelId, externalEventId: 'status:wamid.ORPHAN1:DELIVERED' },
              select: { id: true, status: true },
            })
            .then((e) => (e?.status === 'WAITING_MESSAGE' ? e : null)),
        'inbound WAITING_MESSAGE',
      );

      // Le Message sortant "arrive" (inséré directement — simule un envoi d'une autre voie).
      const conv = await prisma.conversation.findFirstOrThrow({
        where: { channelId },
        select: { id: true, organizationId: true, shopId: true, contactId: true },
      });
      await prisma.message.create({
        data: {
          organizationId: conv.organizationId,
          shopId: conv.shopId,
          conversationId: conv.id,
          channelId,
          contactId: conv.contactId,
          externalMessageId: 'wamid.ORPHAN1',
          direction: 'OUTBOUND',
          type: 'TEXT',
          status: 'SENT',
          senderType: 'AGENT',
          textContent: 'msg orphelin',
          sentAt: new Date(),
        },
      });

      // Le sweep republie le WAITING_MESSAGE → réconciliation → PROCESSED.
      await waitFor(
        () =>
          prisma.whatsAppInboundEvent
            .findUnique({ where: { id: waiting.id }, select: { status: true } })
            .then((e) => (e?.status === 'PROCESSED' ? e : null)),
        'inbound réconcilié PROCESSED',
        20000,
      );
      const message = await prisma.message.findFirstOrThrow({
        where: { channelId, externalMessageId: 'wamid.ORPHAN1' },
        select: { status: true },
      });
      expect(message.status).toBe('DELIVERED');
    });

    it('statut jamais réconcilié → ORPHANED après expiration (terminal, non FAILED)', async () => {
      const raw = statusWebhook({ messageId: 'wamid.NEVER', status: 'read', recipient: CUSTOMER });
      await postWebhook(raw, sign(raw)).expect(200);

      const waiting = await waitFor(
        () =>
          prisma.whatsAppInboundEvent
            .findFirst({
              where: { channelId, externalEventId: 'status:wamid.NEVER:READ' },
              select: { id: true, status: true },
            })
            .then((e) => (e?.status === 'WAITING_MESSAGE' ? e : null)),
        'inbound WAITING_MESSAGE (never)',
      );
      // Vieillit l'événement au-delà du TTL orphelin (3 s) — le sweep le passe ORPHANED.
      await prisma.whatsAppInboundEvent.update({
        where: { id: waiting.id },
        data: { createdAt: new Date(Date.now() - 10000) },
      });
      await waitFor(
        () =>
          prisma.whatsAppInboundEvent
            .findUnique({ where: { id: waiting.id }, select: { status: true } })
            .then((e) => (e?.status === 'ORPHANED' ? e : null)),
        'inbound ORPHANED',
        20000,
      );
    });
  });

  // ------------------------------------------------------------ endpoints

  describe('Endpoints channel Meta — isolation et garde-fous', () => {
    it('send-test exige confirm=true', async () => {
      await authed(owner, 'post', `/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/meta/send-test`)
        .send({ to: '+237650111222', text: 'test' })
        .expect(400);
      await authed(owner, 'post', `/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/meta/send-test`)
        .send({ to: '+237650111222', text: 'test', confirm: false })
        .expect(400);
    });

    it('send-test avec confirm=true → envoi réel (faux Graph), providerMessageId renvoyé', async () => {
      const before = graph.postMessagesCount();
      const res = await authed(
        owner,
        'post',
        `/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/meta/send-test`,
      )
        .send({ to: '+237650111222', text: 'ping', confirm: true })
        .expect(201);
      expect(res.body.sent).toBe(true);
      expect(res.body.providerMessageId).toMatch(/^wamid\.SENT\./);
      expect(graph.postMessagesCount()).toBe(before + 1);
    });

    it('canal Meta d’une autre organisation inaccessible (404)', async () => {
      await authed(outsider, 'get', `/api/organizations/${orgBId}/shops/${shopId}/whatsapp-channel/meta/health`).expect(
        404,
      );
    });

    it('aucun secret dans les réponses (token/app secret jamais sérialisés)', async () => {
      const res = await authed(owner, 'get', `/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel`).expect(200);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('test-access-token');
      expect(serialized).not.toContain('test-app-secret');
    });
  });

  // ------------------------------------------------------------ non-régression

  describe('Non-régression rawBody : les endpoints JSON fonctionnent toujours', () => {
    it('login JSON classique parse le corps normalement', async () => {
      await request(server).post('/api/auth/login').send({ email: owner.email, password: PASSWORD }).expect(200);
    });

    it('provider MOCK inchangé : un canal MOCK se connecte sur une autre Shop', async () => {
      const shop2 = await authed(owner, 'post', `/api/organizations/${orgId}/shops`)
        .send({ name: `Mock Shop ${RUN_ID}`, countryCode: 'CM' })
        .expect(201);
      const mock = await authed(
        owner,
        'post',
        `/api/organizations/${orgId}/shops/${shop2.body.id}/whatsapp-channel/mock`,
      )
        .send({ displayName: 'Mock', phoneNumber: '+237650777888' })
        .expect(201);
      expect(mock.body.provider).toBe('MOCK');
      expect(mock.body.status).toBe('CONNECTED');
    });
  });
});
