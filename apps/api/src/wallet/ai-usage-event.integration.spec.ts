import { readFileSync } from 'node:fs';

import { PrismaClient } from '@whauto/database';

import type { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';

/**
 * Tests d'INTÉGRATION du modèle AiUsageEvent (groupe 3) : lien 1:1 avec AiRun,
 * idempotencyKey unique, CHECK (crédits), cohérence cross-tenant. Ce groupe ne
 * fournit AUCUN service de réservation/débit (G4/G5) — on valide les invariants
 * du modèle en base.
 */

jest.setTimeout(60000);

function databaseUrl(): string {
  const raw = readFileSync('C:/Users/Emma/Desktop/Whauto AI/.env', 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL introuvable');
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
const wallet = new WalletService(prisma as unknown as PrismaService);
const SUFFIX = `usage-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdOrgIds: string[] = [];

interface Seed {
  orgId: string;
  shopId: string;
  walletId: string;
  runId: string;
}

let counter = 0;
async function seed(tag: string): Promise<Seed> {
  counter += 1;
  const org = await prisma.organization.create({
    data: { name: `U ${tag} ${SUFFIX}`, slug: `u-${tag}-${SUFFIX}` },
    select: { id: true },
  });
  createdOrgIds.push(org.id);
  const w = await wallet.ensureWallet(org.id);
  const shop = await prisma.shop.create({
    data: { organizationId: org.id, name: 'S', slug: `s-${tag}-${SUFFIX}`, status: 'ACTIVE', countryCode: 'CM', timezone: 'Africa/Douala', currency: 'XAF', locale: 'fr' },
    select: { id: true },
  });
  const channel = await prisma.whatsAppChannel.create({
    data: { organizationId: org.id, shopId: shop.id, provider: 'MOCK', status: 'CONNECTED', displayName: 'C', phoneNumber: `+2376${String(20000000 + counter).slice(-8)}` },
    select: { id: true },
  });
  const contact = await prisma.contact.create({
    data: { organizationId: org.id, shopId: shop.id, whatsappPhone: `+2377${String(20000000 + counter).slice(-8)}`, normalizedPhone: `+2377${String(20000000 + counter).slice(-8)}` },
    select: { id: true },
  });
  const conversation = await prisma.conversation.create({
    data: { organizationId: org.id, shopId: shop.id, channelId: channel.id, contactId: contact.id, status: 'OPEN' },
    select: { id: true },
  });
  const msg = await prisma.message.create({
    data: { organizationId: org.id, shopId: shop.id, conversationId: conversation.id, channelId: channel.id, contactId: contact.id, direction: 'INBOUND', type: 'TEXT', status: 'RECEIVED', senderType: 'CUSTOMER', textContent: 'hi' },
    select: { id: true },
  });
  const run = await prisma.aiRun.create({
    data: { organizationId: org.id, shopId: shop.id, conversationId: conversation.id, triggerMessageId: msg.id, contextLastMessageId: msg.id, provider: 'MOCK', model: 'mock', mode: 'AUTO_REPLY', status: 'SUCCEEDED' },
    select: { id: true },
  });
  return { orgId: org.id, shopId: shop.id, walletId: w.id, runId: run.id };
}

function usageData(s: Seed, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: s.orgId,
    shopId: s.shopId,
    walletId: s.walletId,
    aiRunId: s.runId,
    provider: 'MOCK' as const,
    creditsReserved: 3,
    creditsCharged: 0,
    status: 'RESERVED' as const,
    idempotencyKey: `${SUFFIX}-${s.runId}`,
    ...overrides,
  };
}

afterAll(async () => {
  for (const id of createdOrgIds) {
    await prisma.aiUsageEvent.deleteMany({ where: { organizationId: id } });
    await prisma.aiRun.deleteMany({ where: { organizationId: id } });
    await prisma.message.deleteMany({ where: { organizationId: id } });
    await prisma.conversation.deleteMany({ where: { organizationId: id } });
    await prisma.contact.deleteMany({ where: { organizationId: id } });
    await prisma.whatsAppChannel.deleteMany({ where: { organizationId: id } });
    await prisma.shop.deleteMany({ where: { organizationId: id } });
    await prisma.walletTransaction.deleteMany({ where: { organizationId: id } });
    await prisma.wallet.deleteMany({ where: { organizationId: id } });
    await prisma.organization.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});

describe('AiUsageEvent — invariants EN BASE', () => {
  it('crée un événement de consommation RESERVED lié au run', async () => {
    const s = await seed('ok');
    const event = await prisma.aiUsageEvent.create({ data: usageData(s), select: { id: true, status: true, creditsReserved: true } });
    expect(event).toMatchObject({ status: 'RESERVED', creditsReserved: 3 });
  });

  it('1:1 avec AiRun : un second UsageEvent pour le même run → P2002', async () => {
    const s = await seed('unique');
    await prisma.aiUsageEvent.create({ data: usageData(s) });
    await expect(
      prisma.aiUsageEvent.create({ data: usageData(s, { idempotencyKey: `${SUFFIX}-other-${s.runId}` }) }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('idempotencyKey unique', async () => {
    const s1 = await seed('idem1');
    const s2 = await seed('idem2');
    await prisma.aiUsageEvent.create({ data: usageData(s1, { idempotencyKey: `${SUFFIX}-shared` }) });
    await expect(
      prisma.aiUsageEvent.create({ data: usageData(s2, { idempotencyKey: `${SUFFIX}-shared` }) }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('CHECK : creditsCharged > creditsReserved refusé', async () => {
    const s = await seed('check');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO ai_usage_events (id,"organizationId","shopId","walletId","aiRunId",provider,"creditsReserved","creditsCharged","toolRounds","successfulToolCalls",status,"idempotencyKey","createdAt") VALUES ('${SUFFIX}-chk','${s.orgId}','${s.shopId}','${s.walletId}','${s.runId}','MOCK',3,5,0,0,'CHARGED','${SUFFIX}-chk-key',now())`,
      ),
    ).rejects.toThrow();
  });

  it('cross-tenant : UsageEvent ne peut référencer un Wallet d’une AUTRE org (FK composite)', async () => {
    const a = await seed('crossa');
    const b = await seed('crossb');
    // organizationId = b, mais walletId = wallet de a → FK composite refuse.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO ai_usage_events (id,"organizationId","shopId","walletId","aiRunId",provider,"creditsReserved","creditsCharged","toolRounds","successfulToolCalls",status,"idempotencyKey","createdAt") VALUES ('${SUFFIX}-cross','${b.orgId}','${b.shopId}','${a.walletId}','${b.runId}','MOCK',1,0,0,0,'RESERVED','${SUFFIX}-cross-key',now())`,
      ),
    ).rejects.toThrow();
  });

  it('supprimer le run cascade l’UsageEvent (lié au cycle du run)', async () => {
    const s = await seed('cascade');
    await prisma.aiUsageEvent.create({ data: usageData(s) });
    await prisma.aiRun.delete({ where: { id: s.runId } });
    expect(await prisma.aiUsageEvent.count({ where: { aiRunId: s.runId } })).toBe(0);
  });
});
