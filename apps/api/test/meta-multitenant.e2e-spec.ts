// P1-G9 — e2e MULTI-ORGANISATION du Meta multi-tenant. Deux commerçants (orgs)
// possèdent chacun leur connexion WhatsApp (numéro + token CHIFFRÉ distincts).
// On prouve l'isolation de bout en bout à travers le pipeline COMPLET
// (webhook → durable inbox → BullMQ → worker RÉEL → conversation) :
//   1. onboarding indépendant (tokens chiffrés + numéros distincts) ;
//   2. UN webhook portant les DEUX numéros → routage par-tenant, zéro fusion ;
//   3. envoi sortant avec le token + numéro du BON tenant (Bearer capté) ;
//   4. lecture cross-tenant → 404 ;
//   5. déconnexion d'A → token A révoqué, B intact et continue d'envoyer.
//
// Env AVANT l'import d'AppModule (Jest CJS : pas d'import dynamique). Faux Graph
// sur port FIXE sous la plage éphémère Windows. Secrets de TEST uniquement.
import { randomBytes } from 'node:crypto';

const GRAPH_PORT = 45902;
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.AUTH_EXPOSE_TEST_TOKENS = 'true';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.META_MULTI_TENANT_ENABLED = 'true';
process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.META_APP_SECRET = 'test-app-secret';
process.env.META_APP_ID = 'test-app-id';
process.env.META_WEBHOOK_VERIFY_TOKEN = 'test-verify-token';
process.env.META_GRAPH_API_VERSION = 'v21.0';
process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${GRAPH_PORT}`;
process.env.WHATSAPP_RECOVERY_SWEEP_INTERVAL_MS = '1000';
process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REGISTER_MAX = '1000';

import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Redis } from 'ioredis';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(180000);

const APP_SECRET = 'test-app-secret';
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'e2e-password-123';
const WORKER_DIST = resolve(__dirname, '../../whatsapp-worker/dist/main.js');

// --- Faux Graph : onboarding (oauth/subscribe/phone) + envoi + validate -------
interface GraphRequest {
  method: string;
  url: string;
  authorization?: string;
  body: unknown;
}

class FakeGraphServer {
  server!: Server;
  requests: GraphRequest[] = [];
  private counter = 0;

  async start(port: number): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, r);
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const url = req.url ?? '';
      const method = req.method ?? '';
      this.requests.push({
        method,
        url,
        authorization: req.headers['authorization'] as string | undefined,
        body,
      });

      const json = (payload: unknown): void => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Échange OAuth : le token renvoyé DÉRIVE du code → un token distinct par org.
      if (method === 'GET' && url.includes('/oauth/access_token')) {
        const code = new URL(`http://x${url}`).searchParams.get('code') ?? 'none';
        json({ access_token: `AT-${code}`, token_type: 'bearer', expires_in: 5183944 });
        return;
      }
      if (method === 'POST' && url.includes('/subscribed_apps')) {
        json({ success: true });
        return;
      }
      // getPhoneNumber (onboard) et validateConfiguration : GET fields=...
      if (method === 'GET' && url.includes('fields=display_phone_number')) {
        const pn = url.split('?')[0].split('/').pop() ?? 'PN';
        json({ id: pn, display_phone_number: `+237 6 ${pn}`, verified_name: `Store ${pn}`, quality_rating: 'GREEN' });
        return;
      }
      // Envoi sortant.
      if (method === 'POST' && url.includes('/messages')) {
        this.counter += 1;
        json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.SENT.${this.counter}` }] });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  }

  /** Derniers POST /{pn}/messages (l'envoi sortant du tenant). */
  sendCalls(pn: string): GraphRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.url.includes(`/${pn}/messages`));
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
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

interface Tenant {
  user: TestUser;
  orgId: string;
  shopId: string;
  channelId: string;
  code: string;
  pn: string;
  token: string;
  customer: string;
}

interface TestUser {
  email: string;
  accessToken: string;
}

/** Une entrée webhook (un commerçant) pour un numéro donné. */
function entryFor(o: { pn: string; from: string; messageId: string; text: string; name?: string }) {
  return {
    id: 'WABA',
    changes: [
      {
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550', phone_number_id: o.pn },
          contacts: o.name ? [{ wa_id: o.from, profile: { name: o.name } }] : undefined,
          messages: [
            { from: o.from, id: o.messageId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: o.text } },
          ],
        },
      },
    ],
  };
}

describe('Meta multi-tenant multi-organisation (e2e, faux Graph + worker réel)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;
  let worker: ChildProcess;
  const graph = new FakeGraphServer();

  let A: Tenant;
  let B: Tenant;

  async function verifiedUser(tag: string): Promise<TestUser> {
    const email = `e2e-mt-${RUN_ID}-${tag}@e2e.whauto.test`;
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

  function postWebhook(raw: string, signature: string) {
    return request(server)
      .post('/api/webhooks/whatsapp/meta')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .send(raw);
  }

  /** Crée user + org + shop + connexion Meta via Embedded Signup. */
  async function onboardTenant(tag: string, customer: string): Promise<Tenant> {
    const user = await verifiedUser(tag);
    const orgId = (
      await authed(user, 'post', '/api/organizations').send({ name: `MT ${tag} ${RUN_ID}` }).expect(201)
    ).body.organization.id;
    const shopId = (
      await authed(user, 'post', `/api/organizations/${orgId}/shops`)
        .send({ name: `Shop ${tag} ${RUN_ID}`, countryCode: 'CM' })
        .expect(201)
    ).body.id;
    const code = `code-${tag}-${RUN_ID}`;
    const pn = `PN_${tag}_${RUN_ID}`;
    const res = await authed(user, 'post', `/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/meta/embedded-signup`)
      .send({ code, wabaId: `WABA_${tag}_${RUN_ID}`, phoneNumberId: pn, businessId: `BM_${tag}` })
      .expect(201);
    expect(res.body).toMatchObject({ provider: 'META_CLOUD', status: 'CONNECTED', phoneNumberId: pn });
    return { user, orgId, shopId, channelId: res.body.id, code, pn, token: `AT-${code}`, customer };
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

    worker = spawn(process.execPath, [WORKER_DIST], {
      env: { ...process.env, LOG_LEVEL: 'fatal' },
      stdio: 'ignore',
    });

    A = await onboardTenant('A', '237650000001');
    B = await onboardTenant('B', '237650000002');
  });

  afterAll(async () => {
    if (worker) {
      await new Promise<void>((r) => {
        const timer = setTimeout(r, 5000);
        worker.once('exit', () => {
          clearTimeout(timer);
          r();
        });
        worker.kill();
      });
    }
    await app?.close();
    await graph.stop();
  });

  // ---------------------------------------------------------------- onboarding

  describe('Onboarding indépendant de deux organisations', () => {
    it('chaque org a SA connexion : numéro + token CHIFFRÉ distincts, jamais partagés', async () => {
      const connA = await prisma.whatsAppConnection.findFirstOrThrow({
        where: { organizationId: A.orgId, status: 'CONNECTED' },
        select: { phoneNumber: { select: { phoneNumberId: true } }, credential: { select: { accessTokenEncrypted: true } } },
      });
      const connB = await prisma.whatsAppConnection.findFirstOrThrow({
        where: { organizationId: B.orgId, status: 'CONNECTED' },
        select: { phoneNumber: { select: { phoneNumberId: true } }, credential: { select: { accessTokenEncrypted: true } } },
      });

      expect(connA.phoneNumber.phoneNumberId).toBe(A.pn);
      expect(connB.phoneNumber.phoneNumberId).toBe(B.pn);
      expect(A.pn).not.toBe(B.pn);
      // Tokens CHIFFRÉS (enveloppe v1.), distincts, jamais en clair.
      expect(connA.credential.accessTokenEncrypted.startsWith('v1.')).toBe(true);
      expect(connB.credential.accessTokenEncrypted.startsWith('v1.')).toBe(true);
      expect(connA.credential.accessTokenEncrypted).not.toBe(connB.credential.accessTokenEncrypted);
      expect(connA.credential.accessTokenEncrypted).not.toContain(A.token);
      expect(connB.credential.accessTokenEncrypted).not.toContain(B.token);
    });
  });

  // ---------------------------------------------------------------- inbound

  describe('Routage inbound multi-tenant (UN webhook, DEUX commerçants)', () => {
    it('chaque groupe part dans SON canal/org — jamais de fusion', async () => {
      const midA = `wamid.A.${RUN_ID}`;
      const midB = `wamid.B.${RUN_ID}`;
      const raw = JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          entryFor({ pn: A.pn, from: A.customer, messageId: midA, text: 'Bonjour chez A', name: 'Client A' }),
          entryFor({ pn: B.pn, from: B.customer, messageId: midB, text: 'Bonjour chez B', name: 'Client B' }),
        ],
      });
      await postWebhook(raw, sign(raw)).expect(200);

      const msgA = await waitFor(
        () =>
          prisma.message.findFirst({
            where: { channelId: A.channelId, externalMessageId: midA },
            select: { organizationId: true, textContent: true, direction: true },
          }),
        'message A',
      );
      const msgB = await waitFor(
        () =>
          prisma.message.findFirst({
            where: { channelId: B.channelId, externalMessageId: midB },
            select: { organizationId: true, textContent: true },
          }),
        'message B',
      );

      expect(msgA.organizationId).toBe(A.orgId);
      expect(msgA.textContent).toBe('Bonjour chez A');
      expect(msgA.direction).toBe('INBOUND');
      expect(msgB.organizationId).toBe(B.orgId);
      expect(msgB.textContent).toBe('Bonjour chez B');

      // Zéro contamination croisée : le message d'A n'existe PAS sous le canal de B.
      expect(await prisma.message.count({ where: { channelId: B.channelId, externalMessageId: midA } })).toBe(0);
      expect(await prisma.message.count({ where: { channelId: A.channelId, externalMessageId: midB } })).toBe(0);

      // Contacts rattachés à la BONNE Shop.
      const contactA = await prisma.contact.findFirst({ where: { shopId: A.shopId, normalizedPhone: `+${A.customer}` } });
      const contactB = await prisma.contact.findFirst({ where: { shopId: B.shopId, normalizedPhone: `+${B.customer}` } });
      expect(contactA?.displayName).toBe('Client A');
      expect(contactB?.displayName).toBe('Client B');
    });
  });

  // ---------------------------------------------------------------- outbound

  describe('Envoi sortant : token + numéro du BON tenant', () => {
    async function replyAndAssert(t: Tenant, otherPn: string, text: string, cm: string): Promise<void> {
      const conv = await waitFor(
        () => prisma.conversation.findFirst({ where: { channelId: t.channelId }, select: { id: true } }),
        `conversation ${t.pn}`,
      );
      await authed(t.user, 'post', `/api/organizations/${t.orgId}/conversations/${conv.id}/messages`)
        .send({ text, clientMessageId: cm })
        .expect(201);
      await waitFor(
        () =>
          prisma.message
            .findFirst({
              where: { conversationId: conv.id, direction: 'OUTBOUND', textContent: text },
              select: { status: true },
            })
            .then((m) => (m?.status === 'SENT' ? m : null)),
        `SENT ${t.pn}`,
      );

      // Le VRAI provider a appelé /{PN du tenant}/messages avec le token du tenant.
      const call = t.pn === otherPn ? undefined : graph.sendCalls(t.pn).at(-1);
      expect(call?.authorization).toBe(`Bearer ${t.token}`);
    }

    it('A répond → Bearer token A vers numéro A ; B répond → Bearer token B vers numéro B', async () => {
      await replyAndAssert(A, B.pn, 'Réponse depuis A', `cmA-${RUN_ID}`);
      await replyAndAssert(B, A.pn, 'Réponse depuis B', `cmB-${RUN_ID}`);

      // Aucun envoi vers le numéro d'A n'a JAMAIS porté le token de B (et inversement).
      expect(graph.sendCalls(A.pn).every((r) => r.authorization === `Bearer ${A.token}`)).toBe(true);
      expect(graph.sendCalls(B.pn).every((r) => r.authorization === `Bearer ${B.token}`)).toBe(true);
      expect(graph.sendCalls(A.pn).length).toBeGreaterThan(0);
      expect(graph.sendCalls(B.pn).length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------- isolation

  describe('Isolation lecture cross-tenant', () => {
    it('un membre d’A ne voit pas le canal de B (404), et inversement', async () => {
      await authed(A.user, 'get', `/api/organizations/${B.orgId}/shops/${B.shopId}/whatsapp-channel`).expect(404);
      await authed(B.user, 'get', `/api/organizations/${A.orgId}/shops/${A.shopId}/whatsapp-channel`).expect(404);
      // Profil Meta d'une autre org également inaccessible.
      await authed(A.user, 'get', `/api/organizations/${B.orgId}/shops/${B.shopId}/whatsapp-channel/meta/profile`).expect(404);
    });
  });

  // ---------------------------------------------------------------- disconnect

  describe('Déconnexion isolée', () => {
    it('déconnecter A révoque le token d’A sans toucher B ; B continue d’envoyer', async () => {
      await authed(A.user, 'post', `/api/organizations/${A.orgId}/shops/${A.shopId}/whatsapp-channel/disconnect`).expect(200);

      // A : connexion close + credential révoqué.
      expect(
        await prisma.whatsAppConnection.count({
          where: { organizationId: A.orgId, status: { in: ['CONNECTING', 'CONNECTED', 'SUSPENDED'] } },
        }),
      ).toBe(0);
      expect(await prisma.metaWhatsAppCredential.count({ where: { organizationId: A.orgId, status: 'ACTIVE' } })).toBe(0);

      // B : intact.
      expect(
        await prisma.whatsAppConnection.count({
          where: { organizationId: B.orgId, status: { in: ['CONNECTING', 'CONNECTED', 'SUSPENDED'] } },
        }),
      ).toBe(1);
      expect(await prisma.metaWhatsAppCredential.count({ where: { organizationId: B.orgId, status: 'ACTIVE' } })).toBe(1);

      // B envoie toujours, avec SON token — la déconnexion d'A n'a rien cassé.
      const convB = await prisma.conversation.findFirstOrThrow({ where: { channelId: B.channelId }, select: { id: true } });
      const before = graph.sendCalls(B.pn).length;
      await authed(B.user, 'post', `/api/organizations/${B.orgId}/conversations/${convB.id}/messages`)
        .send({ text: 'B toujours actif', clientMessageId: `cmB2-${RUN_ID}` })
        .expect(201);
      await waitFor(
        () =>
          prisma.message
            .findFirst({ where: { conversationId: convB.id, direction: 'OUTBOUND', textContent: 'B toujours actif' }, select: { status: true } })
            .then((m) => (m?.status === 'SENT' ? m : null)),
        'B SENT après déconnexion A',
      );
      const call = graph.sendCalls(B.pn).at(-1);
      expect(graph.sendCalls(B.pn).length).toBe(before + 1);
      expect(call?.authorization).toBe(`Bearer ${B.token}`);
    });
  });
});
