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
import { buildMetaSignedRequest } from '@whauto/whatsapp';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(90000);

const RUN_ID = Date.now().toString(36);
const PASSWORD = 'e2e-password-123';
const ONBOARD_TOKEN = 'EAAG-onboarded-token-secret';
const FB_USER_ID = 'FBUSER-ES';
const APP_SECRET = 'APP-SECRET';

let fake: Server;
let subscribeAuth: string | undefined;
let profileAuth: string | undefined;
// Profil WhatsApp Business en mémoire côté faux Graph : le POST le met à jour,
// le GET le relit — prouve le round-trip via le VRAI provider (token du tenant).
let businessProfile: Record<string, unknown> = { about: 'Profil initial', vertical: 'UNDEFINED', websites: [] };

function startFake(): Promise<void> {
  fake = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      const raw = Buffer.concat(chunks).toString('utf8');
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
      // Profil : POST met à jour (retire messaging_product), GET relit.
      if (req.method === 'POST' && url.includes('/whatsapp_business_profile')) {
        profileAuth = req.headers.authorization as string | undefined;
        const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
        const fields = { ...body };
        delete fields.messaging_product;
        businessProfile = { ...businessProfile, ...fields };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (req.method === 'GET' && url.includes('/whatsapp_business_profile')) {
        profileAuth = req.headers.authorization as string | undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [businessProfile] }));
        return;
      }
      if (req.method === 'GET' && url.includes('/me?fields=id')) {
        // getAuthenticatedUser : ID FB de l'auteur de l'onboarding.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: FB_USER_ID }));
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
  const disconnectUrl = () => `/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/disconnect`;
  const profileUrl = () => `/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/meta/profile`;

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

  it('déconnecte : connexion DISCONNECTED + credential RÉVOQUÉ (token inutilisable)', async () => {
    // État courant : une connexion active (issue du re-onboarding précédent).
    const before = await prisma.metaWhatsAppCredential.findFirstOrThrow({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: { id: true },
    });

    const res = await request(server).post(disconnectUrl()).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISCONNECTED');

    // Plus aucune connexion active ni canal actif sur la Shop.
    expect(
      await prisma.whatsAppConnection.count({
        where: { organizationId: orgId, shopId, status: { in: ['CONNECTING', 'CONNECTED', 'SUSPENDED'] } },
      }),
    ).toBe(0);
    expect(
      await prisma.whatsAppChannel.count({
        where: { organizationId: orgId, shopId, status: { in: ['CONNECTING', 'CONNECTED', 'SUSPENDED'] } },
      }),
    ).toBe(0);
    // Le token est RÉVOQUÉ (le worker ne résoudra plus aucun provider).
    const cred = await prisma.metaWhatsAppCredential.findUniqueOrThrow({
      where: { id: before.id },
      select: { status: true, revokedAt: true },
    });
    expect(cred.status).toBe('REVOKED');
    expect(cred.revokedAt).not.toBeNull();
  });

  it('reconnecte après déconnexion : nouvelle connexion ACTIVE, tokens précédents révoqués', async () => {
    const revokedBefore = await prisma.metaWhatsAppCredential.count({
      where: { organizationId: orgId, status: 'REVOKED' },
    });

    const res = await request(server)
      .post(url())
      .set(auth())
      .send({ code: 'CODE-3', wabaId: 'WABA-1', phoneNumberId: 'PHONE-1', businessId: 'BM-1' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ provider: 'META_CLOUD', status: 'CONNECTED' });

    // Exactement une connexion active + son credential ACTIVE.
    const active = await prisma.whatsAppConnection.findMany({
      where: { organizationId: orgId, shopId, status: { in: ['CONNECTING', 'CONNECTED', 'SUSPENDED'] } },
      select: { credential: { select: { status: true } } },
    });
    expect(active).toHaveLength(1);
    expect(active[0].credential.status).toBe('ACTIVE');
    // Les anciens tokens restent révoqués (jamais ré-activés).
    expect(
      await prisma.metaWhatsAppCredential.count({ where: { organizationId: orgId, status: 'REVOKED' } }),
    ).toBe(revokedBefore);
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

  it('profil : GET lit le profil via le TOKEN du tenant (aucun secret exposé)', async () => {
    // État : une connexion active (reconnect précédent). Le provider utilise le
    // token DÉCHIFFRÉ du commerçant → le faux Graph reçoit Bearer <ONBOARD_TOKEN>.
    const res = await request(server).get(profileUrl()).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ about: 'Profil initial', vertical: 'UNDEFINED', websites: [] });
    expect(profileAuth).toBe(`Bearer ${ONBOARD_TOKEN}`);
    // Jamais de token dans la réponse HTTP.
    expect(JSON.stringify(res.body)).not.toContain(ONBOARD_TOKEN);
  });

  it('profil : PATCH met à jour puis relit l’état frais + audit META_PROFILE_UPDATED', async () => {
    const res = await request(server)
      .patch(profileUrl())
      .set(auth())
      .send({ about: 'Meilleure boutique de Douala', vertical: 'RETAIL', websites: ['https://boutique.example'] });
    expect(res.status).toBe(200);
    // Réponse = état FRAIS relu après écriture.
    expect(res.body).toMatchObject({
      about: 'Meilleure boutique de Douala',
      vertical: 'RETAIL',
      websites: ['https://boutique.example'],
    });

    // Audit écrit (noms de champs uniquement, jamais le contenu).
    const audit = await prisma.organizationAuditEvent.findFirst({
      where: { organizationId: orgId, eventType: 'META_PROFILE_UPDATED' },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    expect(audit).not.toBeNull();
    const meta = audit?.metadata as { changedFields?: string[] };
    expect(meta.changedFields).toEqual(['about', 'vertical', 'websites']);
    expect(JSON.stringify(audit?.metadata)).not.toContain('Meilleure boutique');
  });

  it('profil : champ invalide (about > 139) → 400, aucun appel Graph', async () => {
    const res = await request(server)
      .patch(profileUrl())
      .set(auth())
      .send({ about: 'x'.repeat(140) });
    expect(res.status).toBe(400);
  });

  // --- Callbacks d'App Review (deauthorize / data-deletion) -----------------

  it('onboarding a capturé le facebookUserId (rattachement des callbacks)', async () => {
    const cred = await prisma.metaWhatsAppCredential.findFirstOrThrow({
      where: { organizationId: orgId, status: 'ACTIVE' },
      select: { facebookUserId: true },
    });
    expect(cred.facebookUserId).toBe(FB_USER_ID);
  });

  it('callback signature invalide → 401, aucune action', async () => {
    await request(server)
      .post('/api/webhooks/whatsapp/meta/deauthorize')
      .type('form')
      .send({ signed_request: 'forged.payload' })
      .expect(401);
    // La connexion reste ACTIVE.
    expect(
      await prisma.whatsAppConnection.count({
        where: { organizationId: orgId, status: { in: ['CONNECTING', 'CONNECTED', 'SUSPENDED'] } },
      }),
    ).toBe(1);
  });

  it('deauthorize signé → démantèle la connexion + révoque le token du user', async () => {
    const signed = buildMetaSignedRequest({ user_id: FB_USER_ID, issued_at: 1700000000 }, APP_SECRET);
    const res = await request(server)
      .post('/api/webhooks/whatsapp/meta/deauthorize')
      .type('form')
      .send({ signed_request: signed })
      .expect(200);
    expect(res.body).toEqual({ success: true });

    // Plus aucune connexion active ; credential(s) du user révoqué(s).
    expect(
      await prisma.whatsAppConnection.count({
        where: { organizationId: orgId, status: { in: ['CONNECTING', 'CONNECTED', 'SUSPENDED'] } },
      }),
    ).toBe(0);
    expect(await prisma.metaWhatsAppCredential.count({ where: { facebookUserId: FB_USER_ID, status: 'ACTIVE' } })).toBe(0);
  });

  it('data-deletion signé → { url, confirmation_code } + statut consultable', async () => {
    const signed = buildMetaSignedRequest({ user_id: FB_USER_ID }, APP_SECRET);
    const res = await request(server)
      .post('/api/webhooks/whatsapp/meta/data-deletion')
      .type('form')
      .send({ signed_request: signed })
      .expect(200);
    expect(typeof res.body.confirmation_code).toBe('string');
    expect(res.body.confirmation_code.length).toBeGreaterThan(0);
    expect(res.body.url).toContain(`code=${res.body.confirmation_code}`);
    // Demande tracée + consultable publiquement.
    const status = await request(server)
      .get(`/api/webhooks/whatsapp/meta/data-deletion/status`)
      .query({ code: res.body.confirmation_code })
      .expect(200);
    expect(status.body).toEqual({ status: 'completed', confirmation_code: res.body.confirmation_code });
  });
});
