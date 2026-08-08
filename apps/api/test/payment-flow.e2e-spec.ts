// Env AVANT l'import d'AppModule : Genius Pay ACTIF, base API pointée sur un FAUX
// serveur local (port FIXE — Jest CJS n'autorise pas l'import dynamique). Secrets
// de TEST uniquement. Le VRAI GeniusPayProvider est exercé (create + status),
// aucun appel vers Genius Pay réel.
const FAKE_PORT = 45901;
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.AUTH_EXPOSE_TEST_TOKENS = 'true';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.PAYMENT_PROVIDER = 'GENIUS_PAY';
process.env.GENIUS_PAY_API_BASE_URL = `http://127.0.0.1:${FAKE_PORT}/api/v1`;
process.env.GENIUS_PAY_API_KEY = 'pk_sandbox_flow';
process.env.GENIUS_PAY_SECRET_KEY = 'sk_sandbox_flow';
process.env.GENIUS_PAY_WEBHOOK_SECRET = 'whsec_sandbox_flow';
process.env.GENIUS_PAY_RETURN_URL = 'https://app.whauto.test/billing/return';
process.env.PAYMENT_RECONCILIATION_MIN_AGE_MS = '1';
process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REGISTER_MAX = '1000';

import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PaymentReconciliationService } from '../src/wallet/payment-reconciliation.service';

const RUN_ID = Date.now().toString(36);
const PASSWORD = 'e2e-password-123';
const WEBHOOK_SECRET = 'whsec_sandbox_flow';

// --- Faux serveur Genius Pay (contrat officiel) -----------------------------
let fake: Server;
let lastCreate: { headers: Record<string, string | string[] | undefined>; body: unknown } | null = null;
let statusToReturn = 'completed';

function startFake(): Promise<void> {
  fake = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.length > 0 ? JSON.parse(raw) : undefined;
      if (req.method === 'POST' && req.url === '/api/v1/merchant/payments') {
        lastCreate = { headers: req.headers, body };
        const ref = `MTX-${(body as { metadata: { reference: string } }).metadata.reference}`;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: { id: 1, reference: ref, amount: (body as { amount: number }).amount, status: 'pending', checkout_url: `https://pay.genius.ci/checkout/${ref}` },
        }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/v1/merchant/payments/')) {
        const ref = decodeURIComponent(req.url.split('/').pop() ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: { reference: ref, amount: 500, currency: 'XAF', status: statusToReturn, metadata: { reference: ref.replace('MTX-', '') } },
        }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { code: 'TRANSACTION_NOT_FOUND' } }));
    });
  });
  return new Promise((resolve) => fake.listen(FAKE_PORT, '127.0.0.1', resolve));
}

function webhookPayload(topUpId: string, event = 'payment.success', status = 'completed', amount = 500) {
  return {
    id: `evt-${topUpId}`,
    event,
    timestamp: '1754049600',
    data: { reference: `MTX-${topUpId}`, amount, currency: 'XAF', status, metadata: { reference: topUpId } },
    environment: 'sandbox',
    api_version: 'v1',
  };
}

describe('Parcours paiement Genius Pay complet (e2e local)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;
  let token: string;
  let orgId: string;
  let packageCredits: number;

  async function verifiedUser(tag: string): Promise<string> {
    const email = `e2e-flow-${RUN_ID}-${tag}@e2e.whauto.test`;
    const reg = await request(server).post('/api/auth/register').send({ email, password: PASSWORD, firstName: 'T', lastName: tag });
    await request(server).post('/api/auth/verify-email').send({ token: new URL(reg.body.devLink).searchParams.get('token') });
    const login = await request(server).post('/api/auth/login').send({ email, password: PASSWORD });
    return login.body.accessToken;
  }

  function signedWebhook(payload: object) {
    const raw = JSON.stringify(payload);
    const ts = '1754049600';
    const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${raw}`).digest('hex');
    return request(server)
      .post('/api/webhooks/payments/genius-pay')
      .set('Content-Type', 'application/json')
      .set('x-webhook-timestamp', ts)
      .set('x-webhook-event', 'payment.success')
      .set('x-webhook-signature', sig)
      .send(raw);
  }

  beforeAll(async () => {
    await startFake();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);

    token = await verifiedUser('owner');
    const orgRes = await request(server).post('/api/organizations').set('Authorization', `Bearer ${token}`).send({ name: `Flow Org ${RUN_ID}` });
    orgId = orgRes.body.organization.id;
    // Un pack XAF de 500 (= 500 crédits mineurs, majeur 500) aligné sur le webhook.
    const pkg = await prisma.creditPackage.create({
      data: { code: `FLOW_${RUN_ID}`, name: 'Flow', priceMinor: 500, currency: 'XAF', creditsGranted: 100, bonusCredits: 0, isActive: true, sortOrder: 1 },
      select: { id: true, creditsGranted: true, bonusCredits: true },
    });
    packageCredits = pkg.creditsGranted + pkg.bonusCredits;
    (globalThis as Record<string, unknown>).__flowPkgId = pkg.id;
  });

  afterAll(async () => {
    await prisma.paymentWebhookEvent.deleteMany({ where: { externalEventId: { startsWith: `evt-` } } });
    await prisma.topUp.deleteMany({ where: { organizationId: orgId } });
    await prisma.walletTransaction.deleteMany({ where: { organizationId: orgId } });
    await prisma.wallet.deleteMany({ where: { organizationId: orgId } });
    await prisma.creditPackage.deleteMany({ where: { code: `FLOW_${RUN_ID}` } });
    await app.close();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const base = () => `/api/organizations/${orgId}/wallet`;
  const pkgId = () => (globalThis as Record<string, unknown>).__flowPkgId as string;

  async function createTopUp(): Promise<string> {
    const res = await request(server).post(`${base()}/top-ups`).set(auth()).send({ creditPackageId: pkgId() });
    expect(res.status).toBe(201);
    // create a RÉELLEMENT appelé le faux Genius Pay (en-têtes marchand + montant majeur).
    expect(lastCreate?.headers['x-api-key']).toBe('pk_sandbox_flow');
    expect((lastCreate?.body as { amount: number }).amount).toBe(500);
    expect(res.body.paymentSession.provider).toBe('GENIUS_PAY');
    expect(res.body.paymentSession.checkoutUrl).toContain('pay.genius.ci/checkout/MTX-');
    expect(res.body.topUp.status).toBe('PENDING');
    return res.body.topUp.id as string;
  }

  it('create → webhook signé → crédit → GET top-up PAID → solde crédité', async () => {
    const topUpId = await createTopUp();

    // Webhook Genius Pay (le seul moyen de confirmer — le returnUrl ne prouve rien).
    const wh = await signedWebhook(webhookPayload(topUpId));
    expect(wh.status).toBe(200);

    // Polling frontend : GET top-up → PAID.
    const topUp = await request(server).get(`${base()}/top-ups/${topUpId}`).set(auth());
    expect(topUp.body.status).toBe('PAID');
    // Solde crédité.
    const wallet = await request(server).get(base()).set(auth());
    expect(wallet.body.balanceCredits).toBe(packageCredits);
  });

  it('webhook rejoué (×3) → un seul crédit', async () => {
    const topUpId = await createTopUp();
    for (let i = 0; i < 3; i += 1) {
      expect((await signedWebhook(webhookPayload(topUpId))).status).toBe(200);
    }
    expect(await prisma.walletTransaction.count({ where: { referenceId: topUpId, type: 'CREDIT_PURCHASE' } })).toBe(1);
    expect((await request(server).get(`${base()}/top-ups/${topUpId}`).set(auth())).body.status).toBe('PAID');
  });

  it('montant du webhook ≠ TopUp figé → REVIEW_REQUIRED, jamais de crédit', async () => {
    const topUpId = await createTopUp();
    const balBefore = (await request(server).get(base()).set(auth())).body.balanceCredits;
    const wh = await signedWebhook(webhookPayload(topUpId, 'payment.success', 'completed', 999));
    expect(wh.status).toBe(200);
    expect((await request(server).get(`${base()}/top-ups/${topUpId}`).set(auth())).body.status).toBe('REVIEW_REQUIRED');
    expect((await request(server).get(base()).set(auth())).body.balanceCredits).toBe(balBefore);
  });

  it('reconciliation : webhook JAMAIS reçu → sondage getPaymentStatus (completed) → crédit', async () => {
    const topUpId = await createTopUp();
    const balBefore = (await request(server).get(base()).set(auth())).body.balanceCredits;
    // Pas de webhook. Le TopUp reste PENDING → la reconciliation sonde le faux serveur.
    statusToReturn = 'completed';
    await app.get(PaymentReconciliationService).sweep();
    expect((await request(server).get(`${base()}/top-ups/${topUpId}`).set(auth())).body.status).toBe('PAID');
    expect((await request(server).get(base()).set(auth())).body.balanceCredits).toBe(balBefore + packageCredits);
  });
});
