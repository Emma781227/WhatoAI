// Env AVANT l'import d'AppModule : multi-tenant Meta ACTIF, clé de chiffrement,
// App Meta de TEST, base Graph pointée sur un FAUX serveur (port FIXE — Jest CJS
// n'autorise pas l'import dynamique). Le VRAI MetaOnboardingClient est exercé.
import { randomBytes } from 'node:crypto';

const FAKE_PORT = 45900;
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.AUTH_EXPOSE_TEST_TOKENS = 'true';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.META_MULTI_TENANT_ENABLED = 'true';
process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString('base64');
process.env.META_APP_ID = 'APP-ID';
process.env.META_APP_SECRET = 'APP-SECRET';
process.env.META_GRAPH_API_BASE_URL = `http://127.0.0.1:${FAKE_PORT}`;
process.env.META_GRAPH_API_VERSION = 'v21.0';
process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REGISTER_MAX = '1000';

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90000);

const RUN_ID = Date.now().toString(36);
const PASSWORD = 'e2e-password-123';
const ONBOARD_TOKEN = 'EAAG-onboarded-token-secret';

let fake: Server;
let subscribeAuth: string | undefined;

function startFake(): Promise<void> {
  fake = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.includes('/oauth/access_token')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: ONBOARD_TOKEN, token_type: 'bearer', expires_in: 5183944 }));
        return;
      }
      if (req.method === 'POST' && url.includes('/subscribed_apps')) {
        subscribeAuth = req.headers.authorization as string | undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (req.method === 'GET' && url.includes('fields=display_phone_number')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ display_phone_number: '+237 6 00 00 00 00', verified_name: 'Ma Boutique', quality_rating: 'GREEN' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  return new Promise((resolve, reject) => {
    fake.once('error', reject);
    fake.listen(FAKE_PORT, '127.0.0.1', () => resolve());
  });
}

describe('Embedded Signup (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;
  let token: string;
  let orgId: string;
  let shopId: string;

  async function verifiedUser(tag: string): Promise<string> {
    const email = `e2e-es-${RUN_ID}-${tag}@e2e.whauto.test`;
    const reg = await request(server).post('/api/auth/register').send({ email, password: PASSWORD, firstName: 'T', lastName: tag });
    await request(server).post('/api/auth/verify-email').send({ token: new URL(reg.body.devLink).searchParams.get('token') });
    const login = await request(server).post('/api/auth/login').send({ email, password: PASSWORD });
    return login.body.accessToken;
  }

  beforeAll(async () => {
    await startFake();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);

    token = await verifiedUser('owner');
    const orgRes = await request(server).post('/api/organizations').set('Authorization', `Bearer ${token}`).send({ name: `ES Org ${RUN_ID}` });
    orgId = orgRes.body.organization.id;
    const shopRes = await request(server).post(`/api/organizations/${orgId}/shops`).set('Authorization', `Bearer ${token}`).send({ name: `ES Shop ${RUN_ID}`, countryCode: 'CM' });
    shopId = shopRes.body.id;
  });

  afterAll(async () => {
    await prisma.whatsAppConnection.deleteMany({ where: { organizationId: orgId } });
    await prisma.metaWhatsAppCredential.deleteMany({ where: { organizationId: orgId } });
    await prisma.whatsAppPhoneNumber.deleteMany({ where: { organizationId: orgId } });
    await prisma.metaBusinessAccount.deleteMany({ where: { organizationId: orgId } });
    await app.close();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const url = () => `/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/meta/embedded-signup`;

  it('onboarde : échange OAuth + subscribe + provisioning → canal CONNECTED, token CHIFFRÉ', async () => {
    const res = await request(server).post(url()).set(auth()).send({ code: 'CODE-1', wabaId: 'WABA-1', phoneNumberId: 'PHONE-1', businessId: 'BM-1' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ provider: 'META_CLOUD', status: 'CONNECTED', phoneNumberId: 'PHONE-1' });
    // Jamais le token dans la réponse.
    expect(JSON.stringify(res.body)).not.toContain(ONBOARD_TOKEN);

    // App abonnée avec le token obtenu.
    expect(subscribeAuth).toBe(`Bearer ${ONBOARD_TOKEN}`);

    // Connexion + credential + numéro provisionnés.
    const conn = await prisma.whatsAppConnection.findFirstOrThrow({ where: { organizationId: orgId, shopId, status: 'CONNECTED' }, select: { metaWhatsAppCredentialId: true } });
    const cred = await prisma.metaWhatsAppCredential.findUniqueOrThrow({ where: { id: conn.metaWhatsAppCredentialId }, select: { accessTokenEncrypted: true } });
    // Token stocké CHIFFRÉ (enveloppe), jamais en clair.
    expect(cred.accessTokenEncrypted).not.toContain(ONBOARD_TOKEN);
    expect(cred.accessTokenEncrypted.startsWith('v1.')).toBe(true);

    const channels = await prisma.whatsAppChannel.count({ where: { organizationId: orgId, shopId, status: 'CONNECTED', provider: 'META_CLOUD' } });
    expect(channels).toBe(1);
  });

  it('re-onboarde : remplace (une seule connexion + un seul canal ACTIFS)', async () => {
    const res = await request(server).post(url()).set(auth()).send({ code: 'CODE-2', wabaId: 'WABA-1', phoneNumberId: 'PHONE-1', businessId: 'BM-1' });
    expect(res.status).toBe(201);
    expect(await prisma.whatsAppConnection.count({ where: { organizationId: orgId, shopId, status: { in: ['CONNECTING', 'CONNECTED', 'SUSPENDED'] } } })).toBe(1);
    expect(await prisma.whatsAppChannel.count({ where: { organizationId: orgId, shopId, status: { in: ['CONNECTING', 'CONNECTED', 'SUSPENDED'] } } })).toBe(1);
  });

  it('cross-tenant : onboarder un Shop d’une autre org → 404', async () => {
    const otherToken = await verifiedUser('other');
    const otherOrg = await request(server).post('/api/organizations').set('Authorization', `Bearer ${otherToken}`).send({ name: `ES OrgB ${RUN_ID}` });
    // shopId appartient à orgId, pas à otherOrg → 404.
    const res = await request(server)
      .post(`/api/organizations/${otherOrg.body.organization.id}/shops/${shopId}/whatsapp-channel/meta/embedded-signup`)
      .set({ Authorization: `Bearer ${otherToken}` })
      .send({ code: 'C', wabaId: 'W', phoneNumberId: 'P', businessId: 'B' });
    expect(res.status).toBe(404);
  });
});
