import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@whauto/database';
import type { PaymentProvider, PaymentStatusResult } from '@whauto/payments';

import { OrganizationAuditService } from '../modules/organizations/organization-audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { PaymentProviderFactory } from './payment-provider.factory';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { TopUpService } from './topup.service';
import { WalletService } from './wallet.service';

/**
 * Tests d'intégration (PostgreSQL réel) de l'application d'une issue de paiement
 * (`applyPaymentOutcome`) et de la reconciliation. Le crédit passe TOUJOURS par
 * `creditTopUp` existant : montant/devise contrôlés (D4), idempotence, aucun
 * double crédit. Le provider est STUBBÉ (aucun appel réseau Genius Pay).
 */

jest.setTimeout(60000);

function databaseUrl(): string {
  const raw = readFileSync('C:/Users/Emma/Desktop/Whauto AI/.env', 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL introuvable');
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
const P = prisma as unknown as PrismaService;
const wallet = new WalletService(P);
const audit = new OrganizationAuditService(P);
const emitted: Array<{ event: string; org: string }> = [];
const realtime = {
  emitToOrganization: (org: string, event: string) => emitted.push({ event, org }),
} as unknown as RealtimeService;

// Provider stubbé (GENIUS_PAY) : getPaymentStatus scriptable par test.
let nextStatus: PaymentStatusResult | null = null;
const stubProvider = {
  getProviderName: () => 'GENIUS_PAY',
  getPaymentStatus: async (): Promise<PaymentStatusResult> => {
    if (!nextStatus) throw new Error('no scripted status');
    return nextStatus;
  },
} as unknown as PaymentProvider;
const factory = { get: () => stubProvider } as unknown as PaymentProviderFactory;

const topUps = new TopUpService(P, wallet, audit, factory, realtime);
const config = {
  get: (k: string) =>
    ({
      PAYMENT_RECONCILIATION_MIN_AGE_MS: 60_000,
      PAYMENT_RECONCILIATION_MAX_AGE_MS: 86_400_000,
      PAYMENT_RECONCILIATION_SWEEP_INTERVAL_MS: 120_000,
    })[k],
} as unknown as ConfigService;
const recon = new PaymentReconciliationService(P, config, factory, topUps);

const SUFFIX = `recon-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ids: Record<string, string> = {};
const createdOrgIds: string[] = [];
let seq = 0;

async function seedOrg(): Promise<{ orgId: string; walletId: string }> {
  seq += 1;
  const org = await prisma.organization.create({
    data: { name: `${SUFFIX}-${seq}`, slug: `${SUFFIX}-${seq}` },
    select: { id: true },
  });
  createdOrgIds.push(org.id);
  const w = await wallet.ensureWallet(org.id);
  return { orgId: org.id, walletId: w.id };
}

async function seedTopUp(
  org: { orgId: string; walletId: string },
  opts: { providerPaymentId: string; status?: string; createdAt?: Date; amountMinor?: number; currency?: string } = { providerPaymentId: '' },
): Promise<string> {
  const t = await prisma.topUp.create({
    data: {
      organizationId: org.orgId,
      walletId: org.walletId,
      creditPackageId: ids.pkg,
      provider: 'GENIUS_PAY',
      status: (opts.status as never) ?? 'PENDING',
      amountMinor: opts.amountMinor ?? 500,
      currency: opts.currency ?? 'XAF',
      creditsGranted: 100,
      bonusCredits: 0,
      providerPaymentId: opts.providerPaymentId,
      idempotencyKey: randomUUID(),
      initiatedByUserId: ids.user,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
    select: { id: true },
  });
  return t.id;
}

async function walletRow(walletId: string) {
  return prisma.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { balanceCredits: true } });
}
async function topUpStatus(id: string) {
  return (await prisma.topUp.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `${SUFFIX}@e2e.test`, passwordHash: 'x', firstName: 'T', lastName: 'U' },
    select: { id: true },
  });
  ids.user = user.id;
  const pkg = await prisma.creditPackage.create({
    data: { code: `RECON_${SUFFIX}`, name: 'Test', priceMinor: 500, currency: 'XAF', creditsGranted: 100, bonusCredits: 0, isActive: true, sortOrder: 1 },
    select: { id: true },
  });
  ids.pkg = pkg.id;
});

afterAll(async () => {
  for (const id of createdOrgIds) {
    await prisma.paymentWebhookEvent.deleteMany({ where: { providerPaymentId: { startsWith: `MTX-${SUFFIX}` } } });
    await prisma.topUp.deleteMany({ where: { organizationId: id } });
    await prisma.walletTransaction.deleteMany({ where: { organizationId: id } });
    await prisma.wallet.deleteMany({ where: { organizationId: id } });
    await prisma.organization.deleteMany({ where: { id } });
  }
  await prisma.user.deleteMany({ where: { id: ids.user } });
  await prisma.creditPackage.deleteMany({ where: { code: `RECON_${SUFFIX}` } });
  await prisma.$disconnect();
});

beforeEach(() => {
  emitted.length = 0;
  nextStatus = null;
});

describe('applyPaymentOutcome — crédit contrôlé (réutilise creditTopUp)', () => {
  it('PAID + montant/devise conformes → crédite le Wallet (creditsGranted+bonus) + PAID', async () => {
    const org = await seedOrg();
    const pid = `MTX-${SUFFIX}-ok`;
    const topUpId = await seedTopUp(org, { providerPaymentId: pid });

    const result = await topUps.applyPaymentOutcome({ providerPaymentId: pid, status: 'PAID', amount: 500, currency: 'XAF', reference: topUpId });
    expect(result).toMatchObject({ matched: true, action: 'CREDITED', topUpId });
    expect(await topUpStatus(topUpId)).toBe('PAID');
    expect(await walletRow(org.walletId)).toMatchObject({ balanceCredits: 100 });
    expect(await prisma.walletTransaction.count({ where: { walletId: org.walletId, type: 'CREDIT_PURCHASE' } })).toBe(1);
    expect(emitted.some((e) => e.event === 'wallet.balance.updated')).toBe(true);
  });

  it('PAID mais MONTANT ≠ figé → REVIEW_REQUIRED, JAMAIS de crédit', async () => {
    const org = await seedOrg();
    const pid = `MTX-${SUFFIX}-amt`;
    const topUpId = await seedTopUp(org, { providerPaymentId: pid });

    const result = await topUps.applyPaymentOutcome({ providerPaymentId: pid, status: 'PAID', amount: 999, currency: 'XAF', reference: topUpId });
    expect(result).toMatchObject({ action: 'REVIEW_REQUIRED', reason: 'PAYMENT_AMOUNT_MISMATCH' });
    expect(await topUpStatus(topUpId)).toBe('REVIEW_REQUIRED');
    expect(await walletRow(org.walletId)).toMatchObject({ balanceCredits: 0 });
    expect(await prisma.walletTransaction.count({ where: { walletId: org.walletId } })).toBe(0);
  });

  it('PAID mais DEVISE ≠ figée → REVIEW_REQUIRED, JAMAIS de crédit', async () => {
    const org = await seedOrg();
    const pid = `MTX-${SUFFIX}-cur`;
    const topUpId = await seedTopUp(org, { providerPaymentId: pid });
    const result = await topUps.applyPaymentOutcome({ providerPaymentId: pid, status: 'PAID', amount: 500, currency: 'USD', reference: topUpId });
    expect(result).toMatchObject({ action: 'REVIEW_REQUIRED', reason: 'PAYMENT_CURRENCY_MISMATCH' });
    expect(await walletRow(org.walletId)).toMatchObject({ balanceCredits: 0 });
  });

  it('rejeu (trois fois) → un seul crédit', async () => {
    const org = await seedOrg();
    const pid = `MTX-${SUFFIX}-idem`;
    const topUpId = await seedTopUp(org, { providerPaymentId: pid });
    const out = { providerPaymentId: pid, status: 'PAID' as const, amount: 500, currency: 'XAF', reference: topUpId };
    const r1 = await topUps.applyPaymentOutcome(out);
    const r2 = await topUps.applyPaymentOutcome(out);
    const r3 = await topUps.applyPaymentOutcome(out);
    expect(r1.action).toBe('CREDITED');
    expect(r2.action).toBe('ALREADY_PAID');
    expect(r3.action).toBe('ALREADY_PAID');
    expect(await walletRow(org.walletId)).toMatchObject({ balanceCredits: 100 });
    expect(await prisma.walletTransaction.count({ where: { walletId: org.walletId, type: 'CREDIT_PURCHASE' } })).toBe(1);
  });

  it('FAILED → TopUp FAILED, aucun crédit', async () => {
    const org = await seedOrg();
    const pid = `MTX-${SUFFIX}-fail`;
    const topUpId = await seedTopUp(org, { providerPaymentId: pid });
    await topUps.applyPaymentOutcome({ providerPaymentId: pid, status: 'FAILED', amount: null, currency: null, reference: topUpId });
    expect(await topUpStatus(topUpId)).toBe('FAILED');
    expect(await walletRow(org.walletId)).toMatchObject({ balanceCredits: 0 });
  });

  it('TopUp introuvable → NOT_FOUND, aucune écriture', async () => {
    const result = await topUps.applyPaymentOutcome({ providerPaymentId: `MTX-${SUFFIX}-ghost`, status: 'PAID', amount: 500, currency: 'XAF', reference: null });
    expect(result).toMatchObject({ matched: false, action: 'NOT_FOUND' });
  });
});

describe('Reconciliation — filet des webhooks perdus', () => {
  it('sonde un TopUp PENDING ancien, provider completed → crédite via creditTopUp', async () => {
    const org = await seedOrg();
    const pid = `MTX-${SUFFIX}-poll`;
    const now = Date.now();
    // TopUp assez ancien pour être sondé (createdAt < now - minAge).
    const topUpId = await seedTopUp(org, { providerPaymentId: pid, createdAt: new Date(now - 120_000) });
    nextStatus = { providerPaymentId: pid, status: 'PAID', reference: topUpId, amount: 500, currency: 'XAF' };

    const handled = await recon.sweep(now);
    expect(handled).toBeGreaterThanOrEqual(1);
    expect(await topUpStatus(topUpId)).toBe('PAID');
    expect(await walletRow(org.walletId)).toMatchObject({ balanceCredits: 100 });
  });

  it('rejoue un événement durable inbox coincé RECEIVED → crédite + PROCESSED', async () => {
    const org = await seedOrg();
    const pid = `MTX-${SUFFIX}-stuck`;
    const now = Date.now();
    const topUpId = await seedTopUp(org, { providerPaymentId: pid, createdAt: new Date(now - 120_000) });
    const evt = await prisma.paymentWebhookEvent.create({
      data: {
        provider: 'GENIUS_PAY',
        externalEventId: `${SUFFIX}-stuck-evt`,
        providerPaymentId: pid,
        eventType: 'payment.success',
        normalizedPayload: { providerPaymentId: pid, status: 'PAID', reference: topUpId, amount: 500, currency: 'XAF' },
        status: 'RECEIVED',
        receivedAt: new Date(now - 120_000),
      },
      select: { id: true },
    });
    nextStatus = { providerPaymentId: pid, status: 'PENDING', reference: topUpId, amount: 500, currency: 'XAF' };

    await recon.sweep(now);
    expect(await topUpStatus(topUpId)).toBe('PAID');
    expect((await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: evt.id }, select: { status: true } })).status).toBe('PROCESSED');
  });

  it('TopUp jamais finalisé au-delà de la fenêtre → EXPIRED, aucun crédit', async () => {
    const org = await seedOrg();
    const pid = `MTX-${SUFFIX}-old`;
    const now = Date.now();
    const topUpId = await seedTopUp(org, { providerPaymentId: pid, createdAt: new Date(now - 90_000_000) });
    await recon.sweep(now);
    expect(await topUpStatus(topUpId)).toBe('EXPIRED');
    expect(await walletRow(org.walletId)).toMatchObject({ balanceCredits: 0 });
  });
});
