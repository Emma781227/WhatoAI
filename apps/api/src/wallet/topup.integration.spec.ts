import { readFileSync } from 'node:fs';

import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@whauto/database';
import { MockPaymentDisabledError } from '@whauto/payments';
import { CreditPackageInactiveError, CreditPackageNotFoundError } from '@whauto/wallet';

import type { PrismaService } from '../prisma/prisma.service';
import { OrganizationAuditService } from '../modules/organizations/organization-audit.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { PaymentProviderFactory } from './payment-provider.factory';
import { TopUpService } from './topup.service';
import { WalletService } from './wallet.service';

/**
 * Tests d'INTÉGRATION du flux de recharge (groupe 2) contre la vraie base :
 * création de TopUp, crédit idempotent du Wallet, concurrence, confirmation
 * MOCK, packs inactifs. Le crédit ne doit JAMAIS s'appliquer deux fois.
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
const config = {
  get: (key: string) => ({ PAYMENT_PROVIDER: 'MOCK', ALLOW_MOCK_PAYMENTS: true })[key],
} as unknown as ConfigService;
const factory = new PaymentProviderFactory(config);
const emittedEvents: Array<{ event: string; payload: unknown }> = [];
const realtime = {
  emitToOrganization: (_org: string, event: string, payload: unknown) =>
    emittedEvents.push({ event, payload }),
} as unknown as RealtimeService;
const topups = new TopUpService(P, wallet, audit, factory, realtime);

const SUFFIX = `topup-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ctx = { userAgent: 'jest', ipAddress: '127.0.0.1' };
const ids: Record<string, string> = {};
const createdOrgIds: string[] = [];

async function freshOrg(tag: string): Promise<string> {
  const org = await prisma.organization.create({
    data: { name: `T ${tag} ${SUFFIX}`, slug: `t-${tag}-${SUFFIX}` },
    select: { id: true },
  });
  createdOrgIds.push(org.id);
  await wallet.ensureWallet(org.id);
  return org.id;
}

beforeAll(async () => {
  // Utilisateur réel (FK initiatedByUserId + actorUserId d'audit).
  const user = await prisma.user.create({
    data: { email: `topup-${SUFFIX}@e2e.test`, passwordHash: 'x', firstName: 'T', lastName: 'U' },
    select: { id: true },
  });
  ids.user = user.id;
  // Pack de test dédié (ne dépend pas des packs seedés).
  const starter = await prisma.creditPackage.create({
    data: { code: `STARTER_${SUFFIX}`, name: 'Test', priceMinor: 500, currency: 'XAF', creditsGranted: 100, bonusCredits: 0, isActive: true, sortOrder: 1 },
    select: { id: true },
  });
  ids.pkg = starter.id;
  const inactive = await prisma.creditPackage.create({
    data: { code: `INACTIVE_${SUFFIX}`, name: 'Off', priceMinor: 100, currency: 'XAF', creditsGranted: 10, isActive: false, sortOrder: 9 },
    select: { id: true },
  });
  ids.inactivePkg = inactive.id;
});

afterAll(async () => {
  for (const id of createdOrgIds) {
    await prisma.topUp.deleteMany({ where: { organizationId: id } });
    await prisma.walletTransaction.deleteMany({ where: { organizationId: id } });
    await prisma.wallet.deleteMany({ where: { organizationId: id } });
    await prisma.organization.deleteMany({ where: { id } });
  }
  await prisma.user.deleteMany({ where: { id: ids.user } });
  await prisma.creditPackage.deleteMany({
    where: { code: { in: [`STARTER_${SUFFIX}`, `INACTIVE_${SUFFIX}`, `BONUS_${SUFFIX}`] } },
  });
  await prisma.$disconnect();
});

describe('TopUpService — création & crédit', () => {
  it('createTopUp crée un TopUp PENDING (valeurs figées) + session MOCK', async () => {
    const orgId = await freshOrg('create');
    const { topUp, paymentSession } = await topups.createTopUp(orgId, ids.user, ids.pkg, ctx);
    expect(topUp).toMatchObject({ status: 'PENDING', amountMinor: 500, creditsGranted: 100 });
    expect(paymentSession).toMatchObject({ provider: 'MOCK', status: 'PENDING' });
    expect(paymentSession.checkoutUrl).toContain('mock://');
    const row = await prisma.topUp.findUniqueOrThrow({ where: { id: topUp.id }, select: { providerPaymentId: true } });
    expect(row.providerPaymentId).toBe(`mock_pay_${topUp.id}`);
  });

  it('creditTopUp crédite le Wallet une fois + TopUp PAID + ledger CREDIT_PURCHASE', async () => {
    const orgId = await freshOrg('credit');
    const { topUp } = await topups.createTopUp(orgId, ids.user, ids.pkg, ctx);
    const result = await topups.creditTopUp(topUp.id, ctx);
    expect(result).toMatchObject({ status: 'PAID', alreadyPaid: false, balanceAfterCredits: 100 });

    const w = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: orgId }, select: { balanceCredits: true, reservedCredits: true } });
    expect(w).toMatchObject({ balanceCredits: 100, reservedCredits: 0 });

    const tx = await prisma.walletTransaction.findFirstOrThrow({ where: { organizationId: orgId, type: 'CREDIT_PURCHASE' }, select: { direction: true, amountCredits: true, referenceType: true, referenceId: true } });
    expect(tx).toMatchObject({ direction: 'CREDIT', amountCredits: 100, referenceType: 'TOPUP', referenceId: topUp.id });
  });

  it('creditTopUp est IDEMPOTENT : deux confirmations → un seul crédit', async () => {
    const orgId = await freshOrg('idem');
    const { topUp } = await topups.createTopUp(orgId, ids.user, ids.pkg, ctx);
    const first = await topups.creditTopUp(topUp.id, ctx);
    const second = await topups.creditTopUp(topUp.id, ctx);
    expect(first.alreadyPaid).toBe(false);
    expect(second.alreadyPaid).toBe(true);
    const w = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: orgId }, select: { balanceCredits: true } });
    expect(w.balanceCredits).toBe(100); // JAMAIS 200
    expect(await prisma.walletTransaction.count({ where: { organizationId: orgId, type: 'CREDIT_PURCHASE' } })).toBe(1);
  });

  it('concurrence : deux creditTopUp simultanés → un seul crédit (pas de double)', async () => {
    const orgId = await freshOrg('concurrent');
    const { topUp } = await topups.createTopUp(orgId, ids.user, ids.pkg, ctx);
    const [a, b] = await Promise.allSettled([topups.creditTopUp(topUp.id, ctx), topups.creditTopUp(topUp.id, ctx)]);
    expect([a.status, b.status]).toEqual(['fulfilled', 'fulfilled']);
    const w = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: orgId }, select: { balanceCredits: true } });
    expect(w.balanceCredits).toBe(100);
    expect(await prisma.walletTransaction.count({ where: { organizationId: orgId, type: 'CREDIT_PURCHASE' } })).toBe(1);
  });

  it('avec bonus : le crédit inclut creditsGranted + bonusCredits', async () => {
    const orgId = await freshOrg('bonus');
    const bonusPkg = await prisma.creditPackage.create({
      data: { code: `BONUS_${SUFFIX}`, name: 'Bonus', priceMinor: 2000, currency: 'XAF', creditsGranted: 500, bonusCredits: 50, isActive: true, sortOrder: 5 },
      select: { id: true },
    });
    const { topUp } = await topups.createTopUp(orgId, ids.user, bonusPkg.id, ctx);
    const result = await topups.creditTopUp(topUp.id, ctx);
    expect(result.balanceAfterCredits).toBe(550);
    // Le pack est nettoyé en afterAll (FK Restrict : un TopUp le référence encore).
  });
});

describe('TopUpService — erreurs & garde MOCK', () => {
  it('pack introuvable → CreditPackageNotFoundError', async () => {
    const orgId = await freshOrg('nopkg');
    await expect(topups.createTopUp(orgId, ids.user, 'missing-pkg', ctx)).rejects.toBeInstanceOf(CreditPackageNotFoundError);
  });

  it('pack inactif → CreditPackageInactiveError', async () => {
    const orgId = await freshOrg('inactive');
    await expect(topups.createTopUp(orgId, ids.user, ids.inactivePkg, ctx)).rejects.toBeInstanceOf(CreditPackageInactiveError);
  });

  it('mockConfirm : cross-tenant → 404 (NotFound)', async () => {
    const orgA = await freshOrg('mca');
    const orgB = await freshOrg('mcb');
    const { topUp } = await topups.createTopUp(orgA, ids.user, ids.pkg, ctx);
    await expect(topups.mockConfirm(orgB, topUp.id, ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('mockConfirm désactivé (ALLOW_MOCK_PAYMENTS=false) → MockPaymentDisabledError', async () => {
    const orgId = await freshOrg('mcdisabled');
    const { topUp } = await topups.createTopUp(orgId, ids.user, ids.pkg, ctx);
    const disabledFactory = new PaymentProviderFactory({
      get: (key: string) => ({ PAYMENT_PROVIDER: 'MOCK', ALLOW_MOCK_PAYMENTS: false })[key],
    } as unknown as ConfigService);
    const disabledTopUps = new TopUpService(P, wallet, audit, disabledFactory, realtime);
    await expect(disabledTopUps.mockConfirm(orgId, topUp.id, ctx)).rejects.toBeInstanceOf(MockPaymentDisabledError);
  });

  it('mockConfirm autorisé → crédite le Wallet', async () => {
    const orgId = await freshOrg('mcok');
    const { topUp } = await topups.createTopUp(orgId, ids.user, ids.pkg, ctx);
    const result = await topups.mockConfirm(orgId, topUp.id, ctx);
    expect(result).toMatchObject({ status: 'PAID', alreadyPaid: false, balanceAfterCredits: 100 });
  });
});
