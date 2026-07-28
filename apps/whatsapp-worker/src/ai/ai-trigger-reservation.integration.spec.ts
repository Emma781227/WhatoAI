import { readFileSync } from 'node:fs';

import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@whauto/database';

import { AiTriggerService } from './ai-trigger.service';
import type { AiRealtimeEmitter } from './ai-realtime-emitter.service';
import type { PrismaService } from '../prisma/prisma.service';
import { WalletReservationService } from '../wallet/wallet-reservation.service';

/**
 * Tests d'INTÉGRATION de la RÉSERVATION de crédits (groupe 4) contre PostgreSQL
 * réel : le VRAI AiTriggerService + le VRAI WalletReservationService. Vérifie
 * l'atomicité (RESERVE +3, balance inchangée), l'idempotence, le solde
 * insuffisant (SKIPPED, jamais de Gemini), les statuts Wallet, la libération au
 * supersede, la concurrence (verrou FOR UPDATE) et le realtime filtré.
 */

jest.setTimeout(90000);

function databaseUrl(): string {
  const raw = readFileSync('C:/Users/Emma/Desktop/Whauto AI/.env', 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL introuvable');
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
const P = prisma as unknown as PrismaService;

const config = {
  get: (k: string) => ({ AI_MODE: 'SUGGEST_ONLY', AI_PROVIDER: 'MOCK' } as Record<string, unknown>)[k],
} as unknown as ConfigService;

const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
const emitter = {
  emitToOrganization: (_org: string, event: string, payload: Record<string, unknown>) =>
    emitted.push({ event, payload }),
} as unknown as AiRealtimeEmitter;
const throwingEmitter = {
  emitToOrganization: () => {
    throw new Error('Redis KO');
  },
} as unknown as AiRealtimeEmitter;

const walletSvc = new WalletReservationService(P);
const trigger = new AiTriggerService(P, config, walletSvc, emitter);
const triggerRedisKo = new AiTriggerService(P, config, walletSvc, throwingEmitter);

const SUFFIX = `resv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdOrgIds: string[] = [];
let seq = 0;

interface Ctx {
  organizationId: string;
  shopId: string;
  channelId: string;
  walletId: string;
}

/** Org + Shop ACTIVE + Channel CONNECTED + Wallet au solde/statut voulus. */
async function seedOrg(credits: number, walletStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED' = 'ACTIVE'): Promise<Ctx> {
  seq += 1;
  const tag = `${SUFFIX}-${seq}`;
  const org = await prisma.organization.create({ data: { name: tag, slug: tag }, select: { id: true } });
  createdOrgIds.push(org.id);
  const shop = await prisma.shop.create({
    data: { organizationId: org.id, name: 'S', slug: `s-${tag}`, status: 'ACTIVE', countryCode: 'CM', timezone: 'Africa/Douala', currency: 'XAF', locale: 'fr' },
    select: { id: true },
  });
  const channel = await prisma.whatsAppChannel.create({
    data: { organizationId: org.id, shopId: shop.id, provider: 'MOCK', status: 'CONNECTED', displayName: 'C', phoneNumber: `+2376${String(10000000 + seq).slice(-8)}` },
    select: { id: true },
  });
  const wallet = await prisma.wallet.create({
    data: { organizationId: org.id, balanceCredits: credits, reservedCredits: 0, status: walletStatus },
    select: { id: true },
  });
  return { organizationId: org.id, shopId: shop.id, channelId: channel.id, walletId: wallet.id };
}

/** Nouvelle conversation + contact + message INBOUND TEXT ; renvoie le job data. */
async function newTrigger(ctx: Ctx): Promise<{ conversationId: string; triggerMessageId: string; jobData: Parameters<AiTriggerService['processTrigger']>[0] }> {
  seq += 1;
  const contact = await prisma.contact.create({
    data: { organizationId: ctx.organizationId, shopId: ctx.shopId, whatsappPhone: `+2377${String(10000000 + seq).slice(-8)}`, normalizedPhone: `+2377${String(10000000 + seq).slice(-8)}` },
    select: { id: true },
  });
  const conversation = await prisma.conversation.create({
    data: { organizationId: ctx.organizationId, shopId: ctx.shopId, channelId: ctx.channelId, contactId: contact.id, status: 'OPEN' },
    select: { id: true },
  });
  const message = await addInbound(ctx, conversation.id, contact.id);
  return {
    conversationId: conversation.id,
    triggerMessageId: message,
    jobData: {
      organizationId: ctx.organizationId,
      shopId: ctx.shopId,
      conversationId: conversation.id,
      triggerMessageId: message,
      channelId: ctx.channelId,
      scheduledAt: new Date().toISOString(),
    },
  };
}

async function addInbound(ctx: Ctx, conversationId: string, contactId: string): Promise<string> {
  const msg = await prisma.message.create({
    data: { organizationId: ctx.organizationId, shopId: ctx.shopId, conversationId, channelId: ctx.channelId, contactId, direction: 'INBOUND', type: 'TEXT', status: 'RECEIVED', senderType: 'CUSTOMER', textContent: 'bonjour' },
    select: { id: true },
  });
  return msg.id;
}

async function walletRow(walletId: string) {
  return prisma.wallet.findUniqueOrThrow({
    where: { id: walletId },
    select: { balanceCredits: true, reservedCredits: true, status: true, version: true },
  });
}

beforeEach(() => {
  emitted.length = 0;
});

afterAll(async () => {
  for (const id of createdOrgIds) {
    await prisma.aiUsageEvent.deleteMany({ where: { organizationId: id } });
    await prisma.aiSuggestion.deleteMany({ where: { organizationId: id } });
    await prisma.conversationHandoff.deleteMany({ where: { organizationId: id } });
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

describe('Réservation de crédits IA — intégration PostgreSQL', () => {
  it('solde = 3 : réserve exactement 3, balance INCHANGÉE, run QUEUED, usageEvent RESERVED', async () => {
    const ctx = await seedOrg(3);
    const { triggerMessageId, jobData } = await newTrigger(ctx);
    const result = await trigger.processTrigger(jobData);

    expect(result.outcome).toBe('RUN_CREATED');
    const w = await walletRow(ctx.walletId);
    expect(w).toMatchObject({ balanceCredits: 3, reservedCredits: 3 }); // available = 0
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { triggerMessageId }, select: { status: true } });
    expect(run.status).toBe('QUEUED');
    const usage = await prisma.aiUsageEvent.findUniqueOrThrow({ where: { aiRunId: result.runId! }, select: { status: true, creditsReserved: true, creditsCharged: true, reasonCode: true, walletTransactionId: true } });
    expect(usage).toMatchObject({ status: 'RESERVED', creditsReserved: 3, creditsCharged: 0, reasonCode: 'AI_RUN_RESERVED' });
    const rtx = await prisma.walletTransaction.findMany({ where: { walletId: ctx.walletId }, select: { type: true, direction: true, amountCredits: true, balanceBeforeCredits: true, balanceAfterCredits: true, reservedAfterCredits: true } });
    expect(rtx).toHaveLength(1);
    expect(rtx[0]).toMatchObject({ type: 'AI_USAGE_RESERVATION', direction: 'RESERVE', amountCredits: 3, balanceBeforeCredits: 3, balanceAfterCredits: 3, reservedAfterCredits: 3 });
  });

  it('solde > 3 : réserve 3, disponible restant = solde − 3', async () => {
    const ctx = await seedOrg(10);
    const { jobData } = await newTrigger(ctx);
    expect((await trigger.processTrigger(jobData)).outcome).toBe('RUN_CREATED');
    const w = await walletRow(ctx.walletId);
    expect(w).toMatchObject({ balanceCredits: 10, reservedCredits: 3 }); // available = 7
  });

  it('solde < 3 : run SKIPPED (INSUFFICIENT_CREDITS), AUCUNE réservation ni transaction, wallet.insufficient émis', async () => {
    const ctx = await seedOrg(2);
    const { triggerMessageId, jobData } = await newTrigger(ctx);
    const result = await trigger.processTrigger(jobData);

    expect(result.outcome).toBe('SKIPPED_INSUFFICIENT_CREDITS');
    const w = await walletRow(ctx.walletId);
    expect(w).toMatchObject({ balanceCredits: 2, reservedCredits: 0 });
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { triggerMessageId }, select: { status: true, errorCode: true } });
    expect(run).toMatchObject({ status: 'SKIPPED', errorCode: 'INSUFFICIENT_CREDITS' });
    const usage = await prisma.aiUsageEvent.findUniqueOrThrow({ where: { aiRunId: result.runId! }, select: { status: true, creditsReserved: true } });
    expect(usage).toMatchObject({ status: 'SKIPPED', creditsReserved: 0 });
    expect(await prisma.walletTransaction.count({ where: { walletId: ctx.walletId } })).toBe(0);
    const insufficient = emitted.find((e) => e.event === 'wallet.insufficient');
    expect(insufficient?.payload).toMatchObject({ requiredCredits: 3, availableCredits: 2 });
  });

  it('Wallet SUSPENDED : run SKIPPED (WALLET_SUSPENDED), aucune réservation, pas de wallet.insufficient', async () => {
    const ctx = await seedOrg(100, 'SUSPENDED');
    const { triggerMessageId, jobData } = await newTrigger(ctx);
    const result = await trigger.processTrigger(jobData);
    expect(result.outcome).toBe('SKIPPED_WALLET_SUSPENDED');
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { triggerMessageId }, select: { status: true, errorCode: true } });
    expect(run).toMatchObject({ status: 'SKIPPED', errorCode: 'WALLET_SUSPENDED' });
    expect(await walletRow(ctx.walletId)).toMatchObject({ reservedCredits: 0 });
    expect(emitted.find((e) => e.event === 'wallet.insufficient')).toBeUndefined();
  });

  it('Wallet CLOSED : run SKIPPED (WALLET_CLOSED), aucune réservation', async () => {
    const ctx = await seedOrg(100, 'CLOSED');
    const { triggerMessageId, jobData } = await newTrigger(ctx);
    expect((await trigger.processTrigger(jobData)).outcome).toBe('SKIPPED_WALLET_CLOSED');
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { triggerMessageId }, select: { status: true, errorCode: true } });
    expect(run).toMatchObject({ status: 'SKIPPED', errorCode: 'WALLET_CLOSED' });
    expect(await walletRow(ctx.walletId)).toMatchObject({ reservedCredits: 0 });
  });

  it('même trigger rejoué : un seul run, un seul usageEvent, une seule RESERVE, reserved +3 une fois', async () => {
    const ctx = await seedOrg(10);
    const { triggerMessageId, jobData } = await newTrigger(ctx);
    const first = await trigger.processTrigger(jobData);
    const second = await trigger.processTrigger(jobData);

    expect(first.outcome).toBe('RUN_CREATED');
    expect(second.outcome).toBe('ALREADY_RUN');
    expect(second.runId).toBe(first.runId);
    expect(await prisma.aiRun.count({ where: { triggerMessageId } })).toBe(1);
    expect(await prisma.aiUsageEvent.count({ where: { aiRunId: first.runId! } })).toBe(1);
    expect(await prisma.walletTransaction.count({ where: { walletId: ctx.walletId, direction: 'RESERVE' } })).toBe(1);
    expect(await walletRow(ctx.walletId)).toMatchObject({ balanceCredits: 10, reservedCredits: 3 });
  });

  it('provisioning : Organization SANS Wallet → ensureWallet crée un Wallet à 0 puis INSUFFICIENT', async () => {
    seq += 1;
    const tag = `${SUFFIX}-noWallet-${seq}`;
    const org = await prisma.organization.create({ data: { name: tag, slug: tag }, select: { id: true } });
    createdOrgIds.push(org.id);
    const shop = await prisma.shop.create({ data: { organizationId: org.id, name: 'S', slug: `s-${tag}`, status: 'ACTIVE', countryCode: 'CM', timezone: 'Africa/Douala', currency: 'XAF', locale: 'fr' }, select: { id: true } });
    const channel = await prisma.whatsAppChannel.create({ data: { organizationId: org.id, shopId: shop.id, provider: 'MOCK', status: 'CONNECTED', displayName: 'C', phoneNumber: `+2378${String(10000000 + seq).slice(-8)}` }, select: { id: true } });
    const ctx: Ctx = { organizationId: org.id, shopId: shop.id, channelId: channel.id, walletId: '' };

    const { jobData } = await newTrigger(ctx);
    const result = await trigger.processTrigger(jobData);
    expect(result.outcome).toBe('SKIPPED_INSUFFICIENT_CREDITS');
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { organizationId: org.id }, select: { balanceCredits: true, reservedCredits: true } });
    expect(wallet).toMatchObject({ balanceCredits: 0, reservedCredits: 0 });
  });

  it('supersede : un message plus récent libère la réservation du run antérieur UNE fois, puis réserve le nouveau', async () => {
    const ctx = await seedOrg(10);
    const first = await newTrigger(ctx);
    const r1 = await trigger.processTrigger(first.jobData);
    expect(r1.outcome).toBe('RUN_CREATED');
    expect(await walletRow(ctx.walletId)).toMatchObject({ reservedCredits: 3 });

    // Nouveau message dans la MÊME conversation → nouveau déclencheur.
    const contact = await prisma.message.findFirstOrThrow({ where: { conversationId: first.conversationId }, select: { contactId: true } });
    const msg2 = await addInbound(ctx, first.conversationId, contact.contactId);
    const r2 = await trigger.processTrigger({ ...first.jobData, triggerMessageId: msg2 });

    expect(r2.outcome).toBe('SUPERSEDED_AND_CREATED');
    expect(r2.supersededRunId).toBe(r1.runId);
    // Net : une seule réservation active (3), pas 6, pas 0.
    expect(await walletRow(ctx.walletId)).toMatchObject({ balanceCredits: 10, reservedCredits: 3 });
    // Run antérieur : SUPERSEDED + usageEvent RELEASED (exactement une RELEASE).
    expect((await prisma.aiRun.findUniqueOrThrow({ where: { id: r1.runId! }, select: { status: true } })).status).toBe('SUPERSEDED');
    expect((await prisma.aiUsageEvent.findUniqueOrThrow({ where: { aiRunId: r1.runId! }, select: { status: true } })).status).toBe('RELEASED');
    expect(await prisma.walletTransaction.count({ where: { walletId: ctx.walletId, direction: 'RELEASE', referenceId: r1.runId! } })).toBe(1);
    expect(await prisma.walletTransaction.count({ where: { walletId: ctx.walletId, direction: 'RESERVE' } })).toBe(2);
  });

  it('concurrence : 2 conversations, solde = 3 → une seule réserve, l’autre INSUFFICIENT, jamais de solde négatif', async () => {
    const ctx = await seedOrg(3);
    const a = await newTrigger(ctx);
    const b = await newTrigger(ctx);
    const [ra, rb] = await Promise.all([
      trigger.processTrigger(a.jobData),
      trigger.processTrigger(b.jobData),
    ]);

    const outcomes = [ra.outcome, rb.outcome].sort();
    expect(outcomes).toEqual(['RUN_CREATED', 'SKIPPED_INSUFFICIENT_CREDITS']);
    const w = await walletRow(ctx.walletId);
    expect(w).toMatchObject({ balanceCredits: 3, reservedCredits: 3 }); // available = 0, jamais négatif
    expect(w.reservedCredits).toBeLessThanOrEqual(w.balanceCredits);
    expect(await prisma.walletTransaction.count({ where: { walletId: ctx.walletId, direction: 'RESERVE' } })).toBe(1);
  });

  it('concurrence : 2 conversations, solde = 6 → deux réservations de 3 réussissent', async () => {
    const ctx = await seedOrg(6);
    const a = await newTrigger(ctx);
    const b = await newTrigger(ctx);
    const [ra, rb] = await Promise.all([
      trigger.processTrigger(a.jobData),
      trigger.processTrigger(b.jobData),
    ]);
    expect(ra.outcome).toBe('RUN_CREATED');
    expect(rb.outcome).toBe('RUN_CREATED');
    expect(await walletRow(ctx.walletId)).toMatchObject({ balanceCredits: 6, reservedCredits: 6 }); // available = 0
  });

  it('média (non TEXT) → aucun run, aucune réservation, aucune transaction', async () => {
    const ctx = await seedOrg(10);
    seq += 1;
    const contact = await prisma.contact.create({ data: { organizationId: ctx.organizationId, shopId: ctx.shopId, whatsappPhone: `+2379${String(10000000 + seq).slice(-8)}`, normalizedPhone: `+2379${String(10000000 + seq).slice(-8)}` }, select: { id: true } });
    const conversation = await prisma.conversation.create({ data: { organizationId: ctx.organizationId, shopId: ctx.shopId, channelId: ctx.channelId, contactId: contact.id, status: 'OPEN' }, select: { id: true } });
    const media = await prisma.message.create({ data: { organizationId: ctx.organizationId, shopId: ctx.shopId, conversationId: conversation.id, channelId: ctx.channelId, contactId: contact.id, direction: 'INBOUND', type: 'IMAGE', status: 'RECEIVED', senderType: 'CUSTOMER', textContent: null }, select: { id: true } });
    const result = await trigger.processTrigger({ organizationId: ctx.organizationId, shopId: ctx.shopId, conversationId: conversation.id, triggerMessageId: media.id, channelId: ctx.channelId, scheduledAt: new Date().toISOString() });
    expect(result.outcome).toBe('SKIPPED_UNSUPPORTED_TYPE');
    expect(await walletRow(ctx.walletId)).toMatchObject({ reservedCredits: 0 });
    expect(await prisma.walletTransaction.count({ where: { walletId: ctx.walletId } })).toBe(0);
  });

  it('handoff ouvert → run SKIPPED, aucune réservation', async () => {
    const ctx = await seedOrg(10);
    const { conversationId, jobData } = await newTrigger(ctx);
    await prisma.conversationHandoff.create({ data: { organizationId: ctx.organizationId, shopId: ctx.shopId, conversationId, status: 'REQUESTED', reason: 'test' }, select: { id: true } });
    const result = await trigger.processTrigger(jobData);
    expect(result.outcome).toBe('HANDOFF_SKIPPED');
    expect(await walletRow(ctx.walletId)).toMatchObject({ reservedCredits: 0 });
    expect(await prisma.walletTransaction.count({ where: { walletId: ctx.walletId } })).toBe(0);
  });

  it('Redis KO après commit : la réservation est CONSERVÉE (émission best-effort)', async () => {
    const ctx = await seedOrg(10);
    const { triggerMessageId, jobData } = await newTrigger(ctx);
    const result = await triggerRedisKo.processTrigger(jobData);
    // L'émission a échoué mais le run + la réservation sont committés.
    expect(result.outcome).toBe('RUN_CREATED');
    expect(await walletRow(ctx.walletId)).toMatchObject({ balanceCredits: 10, reservedCredits: 3 });
    const usage = await prisma.aiUsageEvent.findUniqueOrThrow({ where: { aiRunId: result.runId! }, select: { status: true } });
    expect(usage.status).toBe('RESERVED');
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { triggerMessageId }, select: { status: true } });
    expect(run.status).toBe('QUEUED');
  });

  it('realtime filtré : le payload wallet.balance.updated ne porte que soldes + drapeaux (aucun secret)', async () => {
    const ctx = await seedOrg(10);
    const { jobData } = await newTrigger(ctx);
    await trigger.processTrigger(jobData);
    const evt = emitted.find((e) => e.event === 'wallet.balance.updated');
    expect(evt).toBeDefined();
    expect(Object.keys(evt!.payload).sort()).toEqual(
      ['aiAvailable', 'availableCredits', 'balanceCredits', 'conversationId', 'organizationId', 'reservedCredits', 'version', 'walletId'].sort(),
    );
    expect(evt!.payload).toMatchObject({ balanceCredits: 10, reservedCredits: 3, availableCredits: 7, aiAvailable: true });
  });

  it('isolation : réserver dans une org ne touche jamais le Wallet d’une autre org', async () => {
    const a = await seedOrg(3);
    const b = await seedOrg(3);
    const t = await newTrigger(a);
    await trigger.processTrigger(t.jobData);
    expect(await walletRow(a.walletId)).toMatchObject({ reservedCredits: 3 });
    expect(await walletRow(b.walletId)).toMatchObject({ balanceCredits: 3, reservedCredits: 0 });
  });
});
