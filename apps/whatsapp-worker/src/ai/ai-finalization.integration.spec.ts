import { readFileSync } from 'node:fs';

import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@whauto/database';

import type { AiRealtimeEmitter } from './ai-realtime-emitter.service';
import { AiReservationSweepService } from './ai-reservation-sweep.service';
import type { PrismaService } from '../prisma/prisma.service';
import { WalletReservationService } from '../wallet/wallet-reservation.service';

/**
 * Tests d'INTÉGRATION de la FINALISATION (groupe 5) contre PostgreSQL réel :
 * débit du coût réel (grille v1 par outils réussis) + libération de la
 * réservation sans double comptage, idempotence, statuts Wallet, et sweep
 * comptable des réservations orphelines (run terminal encore RESERVED).
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
const walletSvc = new WalletReservationService(P);

const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
const emitter = {
  emitToOrganization: (_o: string, event: string, payload: Record<string, unknown>) =>
    emitted.push({ event, payload }),
} as unknown as AiRealtimeEmitter;
const sweepConfig = { get: () => 60000 } as unknown as ConfigService;
const sweep = new AiReservationSweepService(P, sweepConfig, walletSvc, emitter);

const SUFFIX = `final-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdOrgIds: string[] = [];
let seq = 0;

interface Seed {
  organizationId: string;
  shopId: string;
  walletId: string;
  runId: string;
}

/** Seed org+shop+channel+contact+conversation+message+run(QUEUED)+wallet, PUIS réserve 3. */
async function seedReservedRun(
  credits: number,
  opts: { walletStatus?: 'ACTIVE' | 'SUSPENDED' | 'CLOSED'; successfulTools?: number; runStatus?: string } = {},
): Promise<Seed> {
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
  const contact = await prisma.contact.create({
    data: { organizationId: org.id, shopId: shop.id, whatsappPhone: `+2377${String(10000000 + seq).slice(-8)}`, normalizedPhone: `+2377${String(10000000 + seq).slice(-8)}` },
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
    data: { organizationId: org.id, shopId: shop.id, conversationId: conversation.id, triggerMessageId: msg.id, contextLastMessageId: msg.id, provider: 'MOCK', model: 'mock', mode: 'SUGGEST_ONLY', status: 'QUEUED' },
    select: { id: true },
  });
  const wallet = await prisma.wallet.create({
    data: { organizationId: org.id, balanceCredits: credits, reservedCredits: 0, status: 'ACTIVE' },
    select: { id: true },
  });

  // Réservation RÉELLE via la primitive (reserved += 3).
  await prisma.$transaction((tx) =>
    walletSvc.reserveForRunInTx(tx, {
      organizationId: org.id,
      shopId: shop.id,
      walletId: wallet.id,
      aiRunId: run.id,
      provider: 'MOCK',
      requestedModel: 'mock',
    }),
  );

  // Outils RÉUSSIS pour la tarification (D5).
  for (let i = 0; i < (opts.successfulTools ?? 0); i += 1) {
    await prisma.aiToolCall.create({
      data: { aiRunId: run.id, organizationId: org.id, shopId: shop.id, toolName: `tool_${i}`, round: 0, sequence: i, argumentsFiltered: {}, status: 'SUCCEEDED' },
      select: { id: true },
    });
  }
  // Un outil ÉCHOUÉ ne compte pas.
  if (opts.successfulTools !== undefined) {
    await prisma.aiToolCall.create({
      data: { aiRunId: run.id, organizationId: org.id, shopId: shop.id, toolName: 'tool_failed', round: 0, sequence: 99, argumentsFiltered: {}, status: 'FAILED' },
      select: { id: true },
    });
  }

  if (opts.walletStatus && opts.walletStatus !== 'ACTIVE') {
    await prisma.wallet.update({ where: { id: wallet.id }, data: { status: opts.walletStatus }, select: { id: true } });
  }
  if (opts.runStatus) {
    await prisma.aiRun.update({ where: { id: run.id }, data: { status: opts.runStatus as never }, select: { id: true } });
  }
  return { organizationId: org.id, shopId: shop.id, walletId: wallet.id, runId: run.id };
}

async function walletRow(walletId: string) {
  return prisma.wallet.findUniqueOrThrow({ where: { id: walletId }, select: { balanceCredits: true, reservedCredits: true, status: true } });
}
async function usageRow(runId: string) {
  return prisma.aiUsageEvent.findUniqueOrThrow({ where: { aiRunId: runId }, select: { status: true, creditsReserved: true, creditsCharged: true, reasonCode: true, successfulToolCalls: true, walletTransactionId: true } });
}
function finalize(s: Seed, outcome: 'SUGGEST_REPLY' | 'HANDOFF' | 'NO_REPLY' | 'FAILED') {
  return prisma.$transaction((tx) =>
    walletSvc.finalizeRunReservationInTx(tx, { organizationId: s.organizationId, aiRunId: s.runId, outcome }),
  );
}

beforeEach(() => {
  emitted.length = 0;
});

afterAll(async () => {
  for (const id of createdOrgIds) {
    await prisma.aiToolCall.deleteMany({ where: { organizationId: id } });
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

describe('Finalisation de run — débit + libération (intégration PostgreSQL)', () => {
  it('SUGGEST_REPLY 0 outil : débite 1, libère 3 → balance −1, reserved 0, usageEvent CHARGED', async () => {
    const s = await seedReservedRun(10, { successfulTools: 0 });
    expect(await walletRow(s.walletId)).toMatchObject({ balanceCredits: 10, reservedCredits: 3 });

    const r = await finalize(s, 'SUGGEST_REPLY');
    expect(r).toMatchObject({ changed: true, creditsCharged: 1 });
    expect(await walletRow(s.walletId)).toMatchObject({ balanceCredits: 9, reservedCredits: 0 }); // available 9
    const u = await usageRow(s.runId);
    expect(u).toMatchObject({ status: 'CHARGED', creditsReserved: 3, creditsCharged: 1, reasonCode: 'SUGGEST_REPLY_NO_TOOL', successfulToolCalls: 0 });
    const rtx = await prisma.walletTransaction.findMany({ where: { walletId: s.walletId }, select: { type: true, direction: true, amountCredits: true } });
    expect(rtx).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'AI_USAGE_RESERVATION', direction: 'RESERVE', amountCredits: 3 }),
        expect.objectContaining({ type: 'AI_USAGE_DEBIT', direction: 'DEBIT', amountCredits: 1 }),
        expect.objectContaining({ type: 'AI_USAGE_RELEASE', direction: 'RELEASE', amountCredits: 3 }),
      ]),
    );
  });

  it('SUGGEST_REPLY 1 outil réussi : débite 2 (l’outil échoué ne compte pas)', async () => {
    const s = await seedReservedRun(10, { successfulTools: 1 });
    const r = await finalize(s, 'SUGGEST_REPLY');
    expect(r.creditsCharged).toBe(2);
    expect(await walletRow(s.walletId)).toMatchObject({ balanceCredits: 8, reservedCredits: 0 });
    expect(await usageRow(s.runId)).toMatchObject({ status: 'CHARGED', creditsCharged: 2, successfulToolCalls: 1, reasonCode: 'SUGGEST_REPLY_ONE_TOOL' });
  });

  it('SUGGEST_REPLY ≥2 outils : débite 3 (plafond), reserved libéré intégralement', async () => {
    const s = await seedReservedRun(10, { successfulTools: 3 });
    const r = await finalize(s, 'SUGGEST_REPLY');
    expect(r.creditsCharged).toBe(3);
    expect(await walletRow(s.walletId)).toMatchObject({ balanceCredits: 7, reservedCredits: 0 });
    expect(await usageRow(s.runId)).toMatchObject({ status: 'CHARGED', creditsCharged: 3, successfulToolCalls: 3 });
  });

  it.each(['HANDOFF', 'NO_REPLY', 'FAILED'] as const)(
    '%s : non facturé (0 crédit), réservation libérée, usageEvent RELEASED',
    async (outcome) => {
      const s = await seedReservedRun(10);
      const r = await finalize(s, outcome);
      expect(r.creditsCharged).toBe(0);
      expect(await walletRow(s.walletId)).toMatchObject({ balanceCredits: 10, reservedCredits: 0 }); // rien débité
      expect(await usageRow(s.runId)).toMatchObject({ status: 'RELEASED', creditsCharged: 0 });
      expect(await prisma.walletTransaction.count({ where: { walletId: s.walletId, direction: 'DEBIT' } })).toBe(0);
      expect(await prisma.walletTransaction.count({ where: { walletId: s.walletId, direction: 'RELEASE' } })).toBe(1);
    },
  );

  it('idempotence : re-finaliser ne débite pas deux fois', async () => {
    const s = await seedReservedRun(10, { successfulTools: 0 });
    await finalize(s, 'SUGGEST_REPLY');
    const second = await finalize(s, 'SUGGEST_REPLY');
    expect(second).toMatchObject({ changed: false, creditsCharged: 0 });
    expect(await walletRow(s.walletId)).toMatchObject({ balanceCredits: 9, reservedCredits: 0 });
    expect(await prisma.walletTransaction.count({ where: { walletId: s.walletId, direction: 'DEBIT' } })).toBe(1);
  });

  it('Wallet SUSPENDED : ne facture PAS, libère la réservation (favorable au marchand)', async () => {
    const s = await seedReservedRun(10, { successfulTools: 0, walletStatus: 'SUSPENDED' });
    const r = await finalize(s, 'SUGGEST_REPLY');
    expect(r.creditsCharged).toBe(0);
    expect(await walletRow(s.walletId)).toMatchObject({ balanceCredits: 10, reservedCredits: 0 });
    expect(await usageRow(s.runId)).toMatchObject({ status: 'RELEASED', reasonCode: 'NOT_BILLABLE_WALLET_INACTIVE' });
  });

  it('creditsCharged n’excède jamais creditsReserved (invariant CHECK respecté)', async () => {
    const s = await seedReservedRun(10, { successfulTools: 5 });
    const r = await finalize(s, 'SUGGEST_REPLY');
    expect(r.creditsCharged).toBe(3); // plafonné à la réserve (3)
    const u = await usageRow(s.runId);
    expect(u.creditsCharged).toBeLessThanOrEqual(u.creditsReserved);
  });
});

describe('Sweep comptable des réservations orphelines', () => {
  it('run TERMINAL (FAILED) encore RESERVED → sweep libère la réservation', async () => {
    // Réservation faite, puis run passé FAILED EN MASSE (sans finalisation) —
    // exactement le cas du sweep de récupération.
    const s = await seedReservedRun(10);
    await prisma.aiRun.update({ where: { id: s.runId }, data: { status: 'FAILED', errorCode: 'AI_RUN_STUCK' }, select: { id: true } });
    expect(await walletRow(s.walletId)).toMatchObject({ reservedCredits: 3 });

    const released = await sweep.sweep();
    expect(released).toBeGreaterThanOrEqual(1);
    expect(await walletRow(s.walletId)).toMatchObject({ balanceCredits: 10, reservedCredits: 0 });
    expect(await usageRow(s.runId)).toMatchObject({ status: 'RELEASED' });
    expect(emitted.some((e) => e.event === 'wallet.balance.updated')).toBe(true);
  });

  it('run ACTIF (QUEUED) encore RESERVED → sweep NE TOUCHE PAS la réservation', async () => {
    const s = await seedReservedRun(10); // run reste QUEUED
    await sweep.sweep();
    expect(await walletRow(s.walletId)).toMatchObject({ reservedCredits: 3 });
    expect(await usageRow(s.runId)).toMatchObject({ status: 'RESERVED' });
  });
});
