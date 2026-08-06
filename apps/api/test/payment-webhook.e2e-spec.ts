// Overrides d'environnement AVANT l'import d'AppModule. Genius Pay ACTIF avec des
// secrets de TEST (jamais de vraies clés) — le webhook ne fait que vérifier la
// signature + parser + persister (aucun appel réseau Genius Pay).
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.AUTH_EXPOSE_TEST_TOKENS = 'true';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.PAYMENT_PROVIDER = 'GENIUS_PAY';
process.env.GENIUS_PAY_API_BASE_URL = 'http://127.0.0.1:59999/api/v1';
process.env.GENIUS_PAY_API_KEY = 'pk_sandbox_e2e';
process.env.GENIUS_PAY_SECRET_KEY = 'sk_sandbox_e2e';
process.env.GENIUS_PAY_WEBHOOK_SECRET = 'whsec_sandbox_e2e';

import { createHmac, randomUUID } from 'node:crypto';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const RUN_ID = Date.now().toString(36);
const WEBHOOK_SECRET = 'whsec_sandbox_e2e';
const WEBHOOK_URL = '/api/webhooks/payments/genius-pay';

function sign(rawBody: string, timestamp: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
}

describe('Webhook Genius Pay (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;
  const createdEventIds: string[] = [];
  const seed: { userId?: string; pkgId?: string; orgIds: string[] } = { orgIds: [] };

  async function seedTopUp(providerPaymentId: string, amountMinor = 500, currency = 'XAF') {
    const org = await prisma.organization.create({
      data: { name: `PWH ${RUN_ID}-${providerPaymentId}`, slug: `pwh-${RUN_ID}-${providerPaymentId}`.toLowerCase() },
      select: { id: true },
    });
    seed.orgIds.push(org.id);
    const w = await prisma.wallet.create({
      data: { organizationId: org.id, balanceCredits: 0, reservedCredits: 0 },
      select: { id: true },
    });
    const topUp = await prisma.topUp.create({
      data: {
        organizationId: org.id,
        walletId: w.id,
        creditPackageId: seed.pkgId!,
        provider: 'GENIUS_PAY',
        status: 'PENDING',
        amountMinor,
        currency,
        creditsGranted: 100,
        bonusCredits: 0,
        providerPaymentId,
        idempotencyKey: randomUUID(),
        initiatedByUserId: seed.userId!,
      },
      select: { id: true },
    });
    return { orgId: org.id, walletId: w.id, topUpId: topUp.id };
  }

  function payload(eventId: string, event: string, status = 'completed') {
    return {
      id: eventId,
      event,
      timestamp: '1754049600',
      data: {
        object: 'payment',
        reference: `MTX-${eventId}`,
        amount: 500,
        currency: 'XAF',
        status,
        metadata: { reference: `topup-${eventId}` },
      },
      environment: 'sandbox',
      api_version: 'v1',
    };
  }

  /** POST signé (corps BRUT contrôlé — jamais re-sérialisé). */
  function postSigned(raw: string, timestamp: string, signature: string | null, event = 'payment.success') {
    const req = request(server)
      .post(WEBHOOK_URL)
      .set('Content-Type', 'application/json')
      .set('x-webhook-timestamp', timestamp)
      .set('x-webhook-event', event);
    if (signature !== null) {
      req.set('x-webhook-signature', signature);
    }
    return req.send(raw);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);

    const user = await prisma.user.create({
      data: { email: `pwh-${RUN_ID}@e2e.test`, passwordHash: 'x', firstName: 'T', lastName: 'U' },
      select: { id: true },
    });
    seed.userId = user.id;
    const pkg = await prisma.creditPackage.create({
      data: { code: `PWH_${RUN_ID}`, name: 'Test', priceMinor: 500, currency: 'XAF', creditsGranted: 100, bonusCredits: 0, isActive: true, sortOrder: 1 },
      select: { id: true },
    });
    seed.pkgId = pkg.id;
  });

  afterAll(async () => {
    for (const orgId of seed.orgIds) {
      await prisma.topUp.deleteMany({ where: { organizationId: orgId } });
      await prisma.walletTransaction.deleteMany({ where: { organizationId: orgId } });
      await prisma.wallet.deleteMany({ where: { organizationId: orgId } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
    }
    if (seed.userId) await prisma.user.deleteMany({ where: { id: seed.userId } });
    if (seed.pkgId) await prisma.creditPackage.deleteMany({ where: { id: seed.pkgId } });
    if (createdEventIds.length > 0) {
      await prisma.paymentWebhookEvent.deleteMany({
        where: { externalEventId: { in: createdEventIds } },
      });
    }
    await app.close();
  });

  it('webhook signé valide (TopUp inconnu) → 200, persisté + traité (PROCESSED), aucun crédit', async () => {
    const eventId = `${RUN_ID}-ok`;
    createdEventIds.push(eventId);
    const raw = JSON.stringify(payload(eventId, 'payment.success'));
    const ts = '1754049600';
    const res = await postSigned(raw, ts, sign(raw, ts));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const event = await prisma.paymentWebhookEvent.findUniqueOrThrow({
      where: { provider_externalEventId: { provider: 'GENIUS_PAY', externalEventId: eventId } },
      select: { status: true, eventType: true, providerPaymentId: true, normalizedPayload: true },
    });
    // Aucun TopUp rattaché → traité sans crédit (PROCESSED).
    expect(event.status).toBe('PROCESSED');
    expect(event.eventType).toBe('payment.success');
    expect(event.providerPaymentId).toBe(`MTX-${eventId}`);
    // Le payload normalisé ne contient JAMAIS la signature ni un secret.
    expect(JSON.stringify(event.normalizedPayload)).not.toContain(WEBHOOK_SECRET);
    // Aucune WalletTransaction générée par ce webhook (TopUp inconnu).
    expect(await prisma.walletTransaction.count({ where: { referenceId: `topup-${eventId}` } })).toBe(0);
  });

  it('trois livraisons identiques → une seule ligne (dédup provider+externalEventId)', async () => {
    const eventId = `${RUN_ID}-dedup`;
    createdEventIds.push(eventId);
    const raw = JSON.stringify(payload(eventId, 'payment.success'));
    const ts = '1754049600';
    const sig = sign(raw, ts);
    for (let i = 0; i < 3; i += 1) {
      const res = await postSigned(raw, ts, sig);
      expect(res.status).toBe(200);
    }
    expect(
      await prisma.paymentWebhookEvent.count({
        where: { provider: 'GENIUS_PAY', externalEventId: eventId },
      }),
    ).toBe(1);
  });

  it('signature invalide → 401, aucune ligne persistée', async () => {
    const eventId = `${RUN_ID}-badsig`;
    const raw = JSON.stringify(payload(eventId, 'payment.success'));
    const res = await postSigned(raw, '1754049600', 'deadbeef');
    expect(res.status).toBe(401);
    expect(
      await prisma.paymentWebhookEvent.count({ where: { externalEventId: eventId } }),
    ).toBe(0);
  });

  it('signature absente → 401', async () => {
    const eventId = `${RUN_ID}-nosig`;
    const raw = JSON.stringify(payload(eventId, 'payment.success'));
    const res = await postSigned(raw, '1754049600', null);
    expect(res.status).toBe(401);
  });

  it('signature calculée sur le corps SEUL (sans timestamp) → 401', async () => {
    const eventId = `${RUN_ID}-notsts`;
    const raw = JSON.stringify(payload(eventId, 'payment.success'));
    const wrong = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
    const res = await postSigned(raw, '1754049600', wrong);
    expect(res.status).toBe(401);
  });

  it('événement non-payment (webhook.test) signé → 200 + persisté IGNORED', async () => {
    const eventId = `${RUN_ID}-test`;
    createdEventIds.push(eventId);
    const raw = JSON.stringify(payload(eventId, 'webhook.test'));
    const ts = '1754049600';
    const res = await postSigned(raw, ts, sign(raw, ts), 'webhook.test');
    expect(res.status).toBe(200);
    const event = await prisma.paymentWebhookEvent.findUniqueOrThrow({
      where: { provider_externalEventId: { provider: 'GENIUS_PAY', externalEventId: eventId } },
      select: { status: true },
    });
    expect(event.status).toBe('IGNORED');
  });

  it('payment.success signé + montant conforme → TopUp PAID, Wallet crédité, événement PROCESSED', async () => {
    const eventId = `${RUN_ID}-credit`;
    createdEventIds.push(eventId);
    const { walletId, topUpId } = await seedTopUp(`MTX-${eventId}`, 500, 'XAF');
    const raw = JSON.stringify(payload(eventId, 'payment.success'));
    const ts = '1754049600';
    const res = await postSigned(raw, ts, sign(raw, ts));
    expect(res.status).toBe(200);

    expect((await prisma.topUp.findUniqueOrThrow({ where: { id: topUpId }, select: { status: true } })).status).toBe('PAID');
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { balanceCredits: true } })).balanceCredits).toBe(100);
    const event = await prisma.paymentWebhookEvent.findUniqueOrThrow({
      where: { provider_externalEventId: { provider: 'GENIUS_PAY', externalEventId: eventId } },
      select: { status: true },
    });
    expect(event.status).toBe('PROCESSED');
    // Rejeu du webhook → aucun second crédit (idempotence creditTopUp + dédup).
    await postSigned(raw, ts, sign(raw, ts));
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { balanceCredits: true } })).balanceCredits).toBe(100);
    expect(await prisma.walletTransaction.count({ where: { walletId, type: 'CREDIT_PURCHASE' } })).toBe(1);
  });

  it('payment.success mais montant ≠ TopUp figé → REVIEW_REQUIRED, JAMAIS de crédit', async () => {
    const eventId = `${RUN_ID}-mismatch`;
    createdEventIds.push(eventId);
    const { walletId, topUpId } = await seedTopUp(`MTX-${eventId}`, 999, 'XAF'); // figé 999 ≠ webhook 500
    const raw = JSON.stringify(payload(eventId, 'payment.success'));
    const ts = '1754049600';
    const res = await postSigned(raw, ts, sign(raw, ts));
    expect(res.status).toBe(200);

    expect((await prisma.topUp.findUniqueOrThrow({ where: { id: topUpId }, select: { status: true } })).status).toBe('REVIEW_REQUIRED');
    expect((await prisma.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { balanceCredits: true } })).balanceCredits).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { walletId } })).toBe(0);
  });
});
