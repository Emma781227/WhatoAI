import { readFileSync } from 'node:fs';

import type { ConfigService } from '@nestjs/config';
import { MockAiProvider, type AiProvider, type AiProviderResponse } from '@whauto/ai';
import { PrismaClient } from '@whauto/database';

import { AiContextService } from './ai-context.service';
import { AiSummaryService } from './ai-summary.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Résumé roulant de conversation (CI-G2) contre la vraie base.
 *
 * Ce qui est prouvé ici est d'abord ÉCONOMIQUE : le résumé est un appel facturé,
 * donc il ne doit se produire NI sur une conversation courte, NI à chaque
 * message. Le reste vérifie qu'un résumé ne ment jamais sur ce qu'il couvre
 * (ancre) et qu'un échec de résumé ne casse jamais la conversation.
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

const envVars: Record<string, unknown> = {
  AI_SUMMARY_ENABLED: true,
  AI_SUMMARY_MIN_MESSAGES: 6,
  AI_SUMMARY_REFRESH_EVERY_MESSAGES: 4,
  AI_SUMMARY_MAX_INPUT_MESSAGES: 40,
  AI_SUMMARY_MAX_OUTPUT_TOKENS: 250,
};
const config = { get: (k: string) => envVars[k] } as unknown as ConfigService;
const service = new AiSummaryService(P, config);
const contextService = new AiContextService(P);

/** Provider mock instrumenté : on compte les appels de résumé (= la dépense). */
let summaryCalls = 0;
const mock = new MockAiProvider();
const countingProvider: AiProvider = {
  getProviderName: () => 'MOCK',
  generateSuggestion: (input) => mock.generateSuggestion(input),
  continueWithToolResults: (input) => mock.continueWithToolResults(input),
  validateConfiguration: () => mock.validateConfiguration(),
  summarizeConversation: (input) => {
    summaryCalls += 1;
    return mock.summarizeConversation(input);
  },
};
const failingProvider: AiProvider = {
  ...countingProvider,
  summarizeConversation: async (): Promise<AiProviderResponse> => {
    summaryCalls += 1;
    throw new Error('panne simulée du fournisseur');
  },
};

const SUFFIX = `aisum-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ids: Record<string, string> = {};
const base = new Date('2026-08-16T10:00:00.000Z').getTime();
let seq = 0;

async function addMessage(direction: 'INBOUND' | 'OUTBOUND', text: string): Promise<string> {
  seq += 1;
  const m = await prisma.message.create({
    data: {
      organizationId: ids.org,
      shopId: ids.shop,
      conversationId: ids.conversation,
      channelId: ids.channel,
      contactId: ids.contact,
      direction,
      type: 'TEXT',
      status: direction === 'INBOUND' ? 'RECEIVED' : 'SENT',
      senderType: direction === 'INBOUND' ? 'CUSTOMER' : 'AI',
      textContent: text,
      createdAt: new Date(base + seq * 1000),
    },
    select: { id: true },
  });
  return m.id;
}

function ensure(anchorId: string, provider: AiProvider = countingProvider) {
  return service.ensureSummary({
    organizationId: ids.org,
    shopId: ids.shop,
    conversationId: ids.conversation,
    contextLastMessageId: anchorId,
    provider,
    providerName: 'MOCK',
    model: 'mock-model',
    aiRunId: ids.run,
  });
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: SUFFIX, slug: SUFFIX },
    select: { id: true },
  });
  ids.org = org.id;
  const shop = await prisma.shop.create({
    data: {
      organizationId: org.id,
      name: 'Boutique Awa',
      slug: `s-${SUFFIX}`,
      status: 'ACTIVE',
      countryCode: 'CM',
      timezone: 'Africa/Douala',
      currency: 'XAF',
      locale: 'fr',
    },
    select: { id: true },
  });
  ids.shop = shop.id;
  const channel = await prisma.whatsAppChannel.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      provider: 'MOCK',
      status: 'CONNECTED',
      displayName: 'C',
      phoneNumber: '+237600000000',
    },
    select: { id: true },
  });
  ids.channel = channel.id;
  const contact = await prisma.contact.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      whatsappPhone: '+237600000001',
      normalizedPhone: '+237600000001',
    },
    select: { id: true },
  });
  ids.contact = contact.id;
  const conversation = await prisma.conversation.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      channelId: channel.id,
      contactId: contact.id,
      status: 'OPEN',
    },
    select: { id: true },
  });
  ids.conversation = conversation.id;

  const trigger = await addMessage('INBOUND', 'message initial');
  const run = await prisma.aiRun.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      conversationId: conversation.id,
      triggerMessageId: trigger,
      contextLastMessageId: trigger,
      provider: 'MOCK',
      model: 'mock-model',
      mode: 'SUGGEST_ONLY',
      status: 'RUNNING',
    },
    select: { id: true },
  });
  ids.run = run.id;
});

afterAll(async () => {
  const org = ids.org;
  await prisma.conversationSummary.deleteMany({ where: { organizationId: org } });
  await prisma.aiRun.deleteMany({ where: { organizationId: org } });
  await prisma.message.deleteMany({ where: { organizationId: org } });
  await prisma.conversation.deleteMany({ where: { organizationId: org } });
  await prisma.contact.deleteMany({ where: { organizationId: org } });
  await prisma.whatsAppChannel.deleteMany({ where: { organizationId: org } });
  await prisma.shop.deleteMany({ where: { organizationId: org } });
  await prisma.organization.delete({ where: { id: org } });
  await prisma.$disconnect();
});

describe('AiSummaryService — résumé roulant facturé (CI-G2)', () => {
  it('conversation COURTE : aucun appel fournisseur, aucun résumé (dépense évitée)', async () => {
    summaryCalls = 0;
    const anchor = await addMessage('INBOUND', 'bonjour');

    const outcome = await ensure(anchor);

    expect(outcome.reason).toBe('TOO_SHORT');
    expect(outcome.content).toBeNull();
    expect(summaryCalls).toBe(0);
    expect(await prisma.conversationSummary.count({ where: { organizationId: ids.org } })).toBe(0);
  });

  it('au-delà du seuil : UN appel, résumé persisté et ancré sur le message vu', async () => {
    summaryCalls = 0;
    for (let i = 0; i < 6; i += 1) {
      await addMessage(i % 2 === 0 ? 'INBOUND' : 'OUTBOUND', `échange ${i} — je veux une robe taille 42`);
    }
    const anchor = await addMessage('INBOUND', 'et pour la livraison à Douala ?');

    const outcome = await ensure(anchor);

    expect(outcome.reason).toBe('GENERATED');
    expect(summaryCalls).toBe(1);
    expect(outcome.content).toBeTruthy();
    // L'usage est renvoyé à l'appelant : le coût du résumé est facturable.
    expect(outcome.response?.usage).toBeDefined();

    const row = await prisma.conversationSummary.findUniqueOrThrow({
      where: { conversationId: ids.conversation },
      select: {
        content: true,
        coveredThroughMessageId: true,
        coveredMessageCount: true,
        promptVersion: true,
        generatedByAiRunId: true,
        version: true,
      },
    });
    // L'ancre ne ment jamais : le résumé ne prétend pas couvrir plus qu'il n'a vu.
    expect(row.coveredThroughMessageId).toBe(anchor);
    expect(row.coveredMessageCount).toBeGreaterThanOrEqual(7);
    expect(row.promptVersion).toBeTruthy();
    expect(row.generatedByAiRunId).toBe(ids.run);
    expect(row.version).toBe(0);
  });

  it('juste après : le résumé est RÉUTILISÉ sans appel (pas de dépense par message)', async () => {
    summaryCalls = 0;
    const anchor = await addMessage('INBOUND', 'un petit mot de plus');

    const outcome = await ensure(anchor);

    expect(outcome.reason).toBe('REUSED');
    expect(outcome.content).toBeTruthy();
    expect(summaryCalls).toBe(0);
  });

  it('après assez de nouveaux messages : régénéré UNE fois, ancre et version avancées', async () => {
    summaryCalls = 0;
    const before = await prisma.conversationSummary.findUniqueOrThrow({
      where: { conversationId: ids.conversation },
      select: { version: true, coveredThroughMessageId: true },
    });

    for (let i = 0; i < 4; i += 1) {
      await addMessage(i % 2 === 0 ? 'INBOUND' : 'OUTBOUND', `suite ${i}`);
    }
    const anchor = await addMessage('INBOUND', 'je confirme la commande');

    const outcome = await ensure(anchor);

    expect(outcome.reason).toBe('GENERATED');
    expect(summaryCalls).toBe(1);

    const after = await prisma.conversationSummary.findUniqueOrThrow({
      where: { conversationId: ids.conversation },
      select: { version: true, coveredThroughMessageId: true },
    });
    expect(after.version).toBe(before.version + 1);
    expect(after.coveredThroughMessageId).toBe(anchor);
    expect(after.coveredThroughMessageId).not.toBe(before.coveredThroughMessageId);
    // Un SEUL résumé vivant par conversation (jamais un empilement).
    expect(await prisma.conversationSummary.count({ where: { conversationId: ids.conversation } })).toBe(1);
  });

  it('échec fournisseur : le run continue avec le résumé PRÉCÉDENT (jamais une exception)', async () => {
    summaryCalls = 0;
    const previous = await prisma.conversationSummary.findUniqueOrThrow({
      where: { conversationId: ids.conversation },
      select: { content: true, version: true },
    });

    for (let i = 0; i < 4; i += 1) {
      await addMessage('INBOUND', `encore ${i}`);
    }
    const anchor = await addMessage('INBOUND', 'toujours là ?');

    const outcome = await ensure(anchor, failingProvider);

    expect(outcome.reason).toBe('FAILED');
    expect(outcome.content).toBe(previous.content);
    expect(summaryCalls).toBe(1);
    // Rien n'a été écrit : le résumé stocké reste celui qui a réellement été produit.
    const after = await prisma.conversationSummary.findUniqueOrThrow({
      where: { conversationId: ids.conversation },
      select: { version: true },
    });
    expect(after.version).toBe(previous.version);
  });

  it('désactivé par configuration : aucun appel, aucun résumé injecté', async () => {
    summaryCalls = 0;
    envVars.AI_SUMMARY_ENABLED = false;
    const anchor = await addMessage('INBOUND', 'message sous coupe-circuit');

    const outcome = await ensure(anchor);

    expect(outcome.reason).toBe('DISABLED');
    expect(outcome.content).toBeNull();
    expect(summaryCalls).toBe(0);
    envVars.AI_SUMMARY_ENABLED = true;
  });

  it('le résumé atteint le modèle comme NOTE INTERNE, jamais comme parole du client', async () => {
    const anchor = await addMessage('INBOUND', 'dernière question');
    const summary = await prisma.conversationSummary.findUniqueOrThrow({
      where: { conversationId: ids.conversation },
      select: { content: true },
    });

    const ctx = await contextService.build({
      organizationId: ids.org,
      shopId: ids.shop,
      conversationId: ids.conversation,
      contextLastMessageId: anchor,
      contextMaxMessages: 5,
      conversationSummary: summary.content,
      contextTokenBudget: 3000,
    });

    expect(ctx!.systemPrompt).toContain('MÉMOIRE DE LA CONVERSATION');
    expect(ctx!.systemPrompt).toContain(summary.content.slice(0, 40));
    // Il n'est JAMAIS glissé dans le fil des messages.
    expect(ctx!.messages.some((m) => m.content.includes(summary.content.slice(0, 40)))).toBe(false);
  });
});
