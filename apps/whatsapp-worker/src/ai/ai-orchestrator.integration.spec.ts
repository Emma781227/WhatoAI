import { readFileSync } from 'node:fs';

import type { ConfigService } from '@nestjs/config';
import type { AiProvider, AiProviderResponse } from '@whauto/ai';
import { AiProviderError } from '@whauto/ai';
import { PrismaClient } from '@whauto/database';

import { AiContextService } from './ai-context.service';
import { AiSummaryService } from './ai-summary.service';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AiOutboundSenderService } from './ai-outbound-sender.service';
import type { AiProviderFactory } from './ai-provider.factory';
import type { AiRealtimeEmitter } from './ai-realtime-emitter.service';
import { AiToolExecutor } from './tools/tool-executor';
import type { PrismaService } from '../prisma/prisma.service';
import { WalletReservationService } from '../wallet/wallet-reservation.service';

jest.setTimeout(60000);

function databaseUrl(): string {
  const raw = readFileSync('C:/Users/Emma/Desktop/Whauto AI/.env', 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL introuvable');
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
const P = prisma as unknown as PrismaService;

// --- Environnement mutable + stubs -----------------------------------------
const envVars: Record<string, unknown> = {
  AI_MODE: 'SUGGEST_ONLY',
  AI_MAX_OUTPUT_TOKENS: 300,
  AI_CONTEXT_MAX_MESSAGES: 20,
  AI_TOOL_MAX_ROUNDS: 4,
  AI_REQUEST_TIMEOUT_MS: 5000,
  // Ces scénarios testent la BOUCLE de run, pas le résumé (CI-G2) : on le coupe
  // pour qu'aucun appel fournisseur supplémentaire ne consomme le script.
  AI_SUMMARY_ENABLED: false,
};
const config = { get: (k: string) => envVars[k] } as unknown as ConfigService;

const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
const emitter = {
  emitToOrganization: (_org: string, event: string, payload: Record<string, unknown>) =>
    events.push({ event, payload }),
} as unknown as AiRealtimeEmitter;

// Provider scriptable : file de réponses (ou fonctions pour lever une erreur).
type Step = AiProviderResponse | (() => Promise<AiProviderResponse>);
let script: Step[] = [];
let scriptIndex = 0;
let providerCalls = 0;
const scripted: AiProvider = {
  getProviderName: () => 'MOCK',
  generateSuggestion: async () => nextStep(),
  continueWithToolResults: async () => nextStep(),
  validateConfiguration: async () => ({ ok: true }),
  summarizeConversation: async () => nextStep(),
};
async function nextStep(): Promise<AiProviderResponse> {
  providerCalls += 1;
  const step = script[scriptIndex++];
  if (typeof step === 'function') return step();
  if (!step) throw new Error('script épuisé');
  return step;
}

let currentProvider: AiProvider = scripted;
const factory = { getProvider: () => currentProvider } as unknown as AiProviderFactory;

const outboundSender = new AiOutboundSenderService(
  P,
  emitter,
  { add: async () => undefined } as unknown as ConstructorParameters<typeof AiOutboundSenderService>[2],
);
const walletSvc = new WalletReservationService(P);
const orchestrator = new AiOrchestratorService(
  P,
  config,
  new AiContextService(P),
  new AiSummaryService(P, config),
  factory,
  new AiToolExecutor(P),
  emitter,
  outboundSender,
  walletSvc,
);

// --- Fabriques de réponses provider ----------------------------------------
function resp(partial: Partial<AiProviderResponse> & { text: string | null }): AiProviderResponse {
  return {
    toolCalls: [],
    finishReason: partial.text ? 'STOP' : 'STOP',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    latencyMs: 3,
    modelVersion: 'mock-model-x',
    ...partial,
  };
}
function structured(action: string, fields: Record<string, unknown>): string {
  return JSON.stringify({
    action,
    replyText: null,
    handoffReason: null,
    confidence: 0.9,
    usedBusinessData: false,
    ...fields,
  });
}
const suggestResp = (text: string) => resp({ text: structured('SUGGEST_REPLY', { replyText: text }) });
const handoffResp = (reason: string) => resp({ text: structured('HANDOFF', { handoffReason: reason }) });
const noReplyResp = () => resp({ text: structured('NO_REPLY', {}) });
const rawResp = (text: string) => resp({ text });
const toolResp = (name: string, args: Record<string, unknown>): AiProviderResponse =>
  resp({ text: null, finishReason: 'TOOL_CALLS', toolCalls: [{ id: `${name}-0`, name, arguments: args }] });

// --- Seed partagé ----------------------------------------------------------
const ids: Record<string, string> = {};
const SUFFIX = `aiorch-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: SUFFIX, slug: SUFFIX }, select: { id: true } });
  ids.org = org.id;
  const shop = await prisma.shop.create({
    data: { organizationId: org.id, name: 'S', slug: `s-${SUFFIX}`, status: 'ACTIVE', countryCode: 'CM', timezone: 'Africa/Douala', currency: 'XAF', locale: 'fr' },
    select: { id: true },
  });
  ids.shop = shop.id;
  const channel = await prisma.whatsAppChannel.create({
    data: { organizationId: org.id, shopId: shop.id, provider: 'MOCK', status: 'CONNECTED', displayName: 'C', phoneNumber: '+237600000000' },
    select: { id: true },
  });
  ids.channel = channel.id;
  const contact = await prisma.contact.create({
    data: { organizationId: org.id, shopId: shop.id, whatsappPhone: '+237600000001', normalizedPhone: '+237600000001' },
    select: { id: true },
  });
  ids.contact = contact.id;
  const category = await prisma.productCategory.create({
    data: { organizationId: org.id, shopId: shop.id, name: 'Cat', slug: `cat-${SUFFIX}` },
    select: { id: true },
  });
  const product = await prisma.product.create({
    data: { organizationId: org.id, shopId: shop.id, categoryId: category.id, name: 'Sac Rouge', slug: `p-${SUFFIX}`, shortDescription: 'sac', currency: 'XAF', status: 'ACTIVE' },
    select: { id: true },
  });
  const variant = await prisma.productVariant.create({
    data: { organizationId: org.id, shopId: shop.id, productId: product.id, sku: `SKU-${SUFFIX}`.toUpperCase(), priceMinor: 15000, isDefault: true, combinationKey: 'DEFAULT', status: 'ACTIVE', trackInventory: true },
    select: { id: true },
  });
  await prisma.inventoryItem.create({
    data: { organizationId: org.id, shopId: shop.id, variantId: variant.id, quantityOnHand: 7, quantityReserved: 0, lowStockThreshold: 5 },
  });
});

afterAll(async () => {
  const org = ids.org;
  await prisma.aiToolCall.deleteMany({ where: { organizationId: org } });
  await prisma.aiUsageEvent.deleteMany({ where: { organizationId: org } });
  await prisma.aiSuggestion.deleteMany({ where: { organizationId: org } });
  await prisma.conversationHandoff.deleteMany({ where: { organizationId: org } });
  await prisma.aiRun.deleteMany({ where: { organizationId: org } });
  await prisma.walletTransaction.deleteMany({ where: { organizationId: org } });
  await prisma.wallet.deleteMany({ where: { organizationId: org } });
  await prisma.message.deleteMany({ where: { organizationId: org } });
  await prisma.conversation.deleteMany({ where: { organizationId: org } });
  await prisma.inventoryItem.deleteMany({ where: { organizationId: org } });
  await prisma.productVariant.deleteMany({ where: { organizationId: org } });
  await prisma.product.deleteMany({ where: { organizationId: org } });
  await prisma.productCategory.deleteMany({ where: { organizationId: org } });
  await prisma.contact.deleteMany({ where: { organizationId: org } });
  await prisma.whatsAppChannel.deleteMany({ where: { organizationId: org } });
  await prisma.shop.deleteMany({ where: { organizationId: org } });
  await prisma.organization.delete({ where: { id: org } });
  await prisma.$disconnect();
});

beforeEach(() => {
  script = [];
  scriptIndex = 0;
  providerCalls = 0;
  events.length = 0;
  currentProvider = scripted;
  envVars.AI_MODE = 'SUGGEST_ONLY';
  envVars.AI_TOOL_MAX_ROUNDS = 4;
});

/** Crée une conversation fraîche + message(s) + run QUEUED. */
let runCounter = 0;

async function newRun(opts: {
  newerInbound?: boolean;
  newerOutbound?: boolean;
  openHandoff?: boolean;
} = {}): Promise<{ runId: string; conversationId: string }> {
  // Un contact frais par run : l'index partiel n'autorise qu'UNE conversation
  // active par (channel, contact).
  runCounter += 1;
  const phone = `+2376${String(10000000 + runCounter).slice(-8)}`;
  const contact = await prisma.contact.create({
    data: { organizationId: ids.org, shopId: ids.shop, whatsappPhone: phone, normalizedPhone: phone },
    select: { id: true },
  });
  const conversation = await prisma.conversation.create({
    data: { organizationId: ids.org, shopId: ids.shop, channelId: ids.channel, contactId: contact.id, status: 'OPEN' },
    select: { id: true },
  });
  const anchor = await prisma.message.create({
    data: { organizationId: ids.org, shopId: ids.shop, conversationId: conversation.id, channelId: ids.channel, contactId: contact.id, direction: 'INBOUND', type: 'TEXT', status: 'RECEIVED', senderType: 'CUSTOMER', textContent: 'Bonjour, vous avez des sacs ?' },
    select: { id: true, createdAt: true },
  });
  if (opts.newerInbound) {
    await prisma.message.create({
      data: { organizationId: ids.org, shopId: ids.shop, conversationId: conversation.id, channelId: ids.channel, contactId: contact.id, direction: 'INBOUND', type: 'TEXT', status: 'RECEIVED', senderType: 'CUSTOMER', textContent: 'en fait deux', createdAt: new Date(anchor.createdAt.getTime() + 1000) },
    });
  }
  if (opts.newerOutbound) {
    await prisma.message.create({
      data: { organizationId: ids.org, shopId: ids.shop, conversationId: conversation.id, channelId: ids.channel, contactId: contact.id, direction: 'OUTBOUND', type: 'TEXT', status: 'SENT', senderType: 'AGENT', textContent: 'Oui, bonjour', createdAt: new Date(anchor.createdAt.getTime() + 1000) },
    });
  }
  if (opts.openHandoff) {
    await prisma.conversationHandoff.create({
      data: { organizationId: ids.org, shopId: ids.shop, conversationId: conversation.id, status: 'REQUESTED', reason: 'déjà ouvert' },
    });
  }
  const run = await prisma.aiRun.create({
    data: { organizationId: ids.org, shopId: ids.shop, conversationId: conversation.id, triggerMessageId: anchor.id, contextLastMessageId: anchor.id, provider: 'MOCK', model: 'mock-model', mode: 'SUGGEST_ONLY', status: 'QUEUED' },
    select: { id: true },
  });
  return { runId: run.id, conversationId: conversation.id };
}

async function runStatus(runId: string) {
  return prisma.aiRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true, inputTokens: true, outputTokens: true, totalTokens: true, toolRounds: true, resolvedModel: true, promptVersion: true, latencyMs: true } });
}

describe('AiOrchestratorService — décisions (MockAiProvider scripté)', () => {
  it('SUGGEST_REPLY → AiSuggestion PENDING + run SUCCEEDED + événements', async () => {
    script = [suggestResp('Oui, nous avons plusieurs sacs !')];
    const { runId, conversationId } = await newRun();
    await orchestrator.runGeneration(runId);

    expect((await runStatus(runId)).status).toBe('SUCCEEDED');
    const suggestion = await prisma.aiSuggestion.findFirst({ where: { aiRunId: runId } });
    expect(suggestion?.status).toBe('PENDING');
    expect(suggestion?.content).toContain('sacs');
    expect(suggestion?.contextLastMessageId).toBeTruthy();
    // Aucun Message outbound créé.
    const outbound = await prisma.message.count({ where: { conversationId, direction: 'OUTBOUND' } });
    expect(outbound).toBe(0);
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(['ai.run.started', 'ai.run.completed', 'ai.suggestion.created']),
    );
  });

  it('SUGGEST_REPLY avec réservation → DÉBITE le coût réel + libère (finalisation groupe 5)', async () => {
    const wallet = await prisma.wallet.upsert({
      where: { organizationId: ids.org },
      update: { balanceCredits: 20, reservedCredits: 0, status: 'ACTIVE' },
      create: { organizationId: ids.org, balanceCredits: 20, reservedCredits: 0 },
      select: { id: true },
    });
    script = [suggestResp('Oui, en stock !')];
    const { runId } = await newRun();
    // Réservation RÉELLE avant génération (comme le fait AiTriggerService).
    await prisma.$transaction((tx) =>
      walletSvc.reserveForRunInTx(tx, {
        organizationId: ids.org,
        shopId: ids.shop,
        walletId: wallet.id,
        aiRunId: runId,
        provider: 'MOCK',
        requestedModel: 'mock-model',
      }),
    );

    await orchestrator.runGeneration(runId);

    expect((await runStatus(runId)).status).toBe('SUCCEEDED');
    // 0 outil → 1 crédit débité ; réservation (3) intégralement libérée.
    const w = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id }, select: { balanceCredits: true, reservedCredits: true } });
    expect(w).toMatchObject({ balanceCredits: 19, reservedCredits: 0 });
    const usage = await prisma.aiUsageEvent.findUniqueOrThrow({ where: { aiRunId: runId }, select: { status: true, creditsCharged: true } });
    expect(usage).toMatchObject({ status: 'CHARGED', creditsCharged: 1 });
    expect(events.map((e) => e.event)).toContain('wallet.balance.updated');
  });

  it('HANDOFF → ConversationHandoff REQUESTED, aucune suggestion', async () => {
    script = [handoffResp('Demande de remboursement')];
    const { runId, conversationId } = await newRun();
    await orchestrator.runGeneration(runId);

    expect((await runStatus(runId)).status).toBe('SUCCEEDED');
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(0);
    const handoff = await prisma.conversationHandoff.findFirst({ where: { conversationId, aiRunId: runId } });
    expect(handoff?.status).toBe('REQUESTED');
    expect(events.map((e) => e.event)).toContain('ai.handoff.requested');
  });

  it('NO_REPLY → run SUCCEEDED sans suggestion ni handoff', async () => {
    script = [noReplyResp()];
    const { runId, conversationId } = await newRun();
    await orchestrator.runGeneration(runId);
    expect((await runStatus(runId)).status).toBe('SUCCEEDED');
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(0);
    expect(await prisma.conversationHandoff.count({ where: { conversationId, aiRunId: runId } })).toBe(0);
  });

  it('FORCE_HANDOFF (texte annonçant un transfert) → handoff, aucune suggestion', async () => {
    script = [suggestResp('Je vous mets en relation avec un conseiller.')];
    const { runId, conversationId } = await newRun();
    await orchestrator.runGeneration(runId);
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(0);
    expect(await prisma.conversationHandoff.count({ where: { conversationId, aiRunId: runId } })).toBe(1);
  });
});

describe('AiOrchestratorService — sortie invalide', () => {
  it('invalide puis valide → un retry réussit → suggestion', async () => {
    script = [rawResp('pas du json'), suggestResp('Voici votre réponse.')];
    const { runId } = await newRun();
    await orchestrator.runGeneration(runId);
    expect((await runStatus(runId)).status).toBe('SUCCEEDED');
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(1);
    expect(providerCalls).toBe(2);
  });

  it('invalide deux fois → run FAILED, aucune suggestion', async () => {
    script = [rawResp('nope'), rawResp('toujours pas')];
    const { runId } = await newRun();
    await orchestrator.runGeneration(runId);
    expect((await runStatus(runId)).status).toBe('FAILED');
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(0);
    expect(events.map((e) => e.event)).toContain('ai.run.failed');
  });
});

describe('AiOrchestratorService — boucle d’outils', () => {
  it('un outil réussi puis réponse finale', async () => {
    script = [toolResp('search_products', { query: 'sac' }), suggestResp('Nous avons le Sac Rouge.')];
    const { runId } = await newRun();
    await orchestrator.runGeneration(runId);
    const st = await runStatus(runId);
    expect(st.status).toBe('SUCCEEDED');
    expect(st.toolRounds).toBe(1);
    const calls = await prisma.aiToolCall.findMany({ where: { aiRunId: runId }, select: { toolName: true, status: true, round: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolName: 'search_products', status: 'SUCCEEDED', round: 0 });
  });

  it('plusieurs tours d’outils', async () => {
    script = [
      toolResp('search_products', { query: 'sac' }),
      toolResp('get_shop_opening_hours', {}),
      suggestResp('Voilà les infos.'),
    ];
    const { runId } = await newRun();
    await orchestrator.runGeneration(runId);
    expect((await runStatus(runId)).toolRounds).toBe(2);
  });

  it('dépassement de AI_TOOL_MAX_ROUNDS → handoff AI_TOOL_ROUNDS_EXCEEDED, aucun appel Gemini de plus', async () => {
    envVars.AI_TOOL_MAX_ROUNDS = 1;
    script = [toolResp('search_products', { query: 'a' }), toolResp('search_products', { query: 'b' })];
    const { runId, conversationId } = await newRun();
    await orchestrator.runGeneration(runId);
    const handoff = await prisma.conversationHandoff.findFirst({ where: { conversationId, aiRunId: runId }, select: { reason: true } });
    expect(handoff?.reason).toBe('AI_TOOL_ROUNDS_EXCEEDED');
    // Aucun tour supplémentaire : 2 appels provider seulement (gen + 1 continue).
    expect(providerCalls).toBe(2);
  });

  it('outil inconnu demandé par le modèle → REJECTED, run continue', async () => {
    script = [toolResp('drop_table', { x: 1 }), suggestResp('Je continue normalement.')];
    const { runId } = await newRun();
    await orchestrator.runGeneration(runId);
    const call = await prisma.aiToolCall.findFirst({ where: { aiRunId: runId, toolName: 'drop_table' }, select: { status: true, errorCode: true } });
    expect(call).toMatchObject({ status: 'REJECTED', errorCode: 'UNKNOWN_TOOL' });
  });

  it('arguments d’outil invalides → REJECTED', async () => {
    script = [toolResp('get_product_details', { wrong: 'x' }), suggestResp('ok')];
    const { runId } = await newRun();
    await orchestrator.runGeneration(runId);
    const call = await prisma.aiToolCall.findFirst({ where: { aiRunId: runId, toolName: 'get_product_details' }, select: { status: true, errorCode: true } });
    expect(call).toMatchObject({ status: 'REJECTED', errorCode: 'INVALID_ARGUMENTS' });
  });

  it('outil en erreur métier → FAILED tracé, la génération se poursuit', async () => {
    script = [toolResp('get_product_details', { productId: 'inexistant' }), suggestResp('Désolé.')];
    const { runId } = await newRun();
    await orchestrator.runGeneration(runId);
    const call = await prisma.aiToolCall.findFirst({ where: { aiRunId: runId, toolName: 'get_product_details' }, select: { status: true, errorCode: true } });
    expect(call).toMatchObject({ status: 'FAILED', errorCode: 'PRODUCT_NOT_FOUND' });
  });
});

describe('AiOrchestratorService — usage cumulé', () => {
  it('cumule les tokens et la latence sur tous les appels', async () => {
    script = [toolResp('search_products', { query: 'sac' }), suggestResp('ok')];
    const { runId } = await newRun();
    await orchestrator.runGeneration(runId);
    const st = await runStatus(runId);
    expect(st.inputTokens).toBe(20); // 10 + 10
    expect(st.outputTokens).toBe(10); // 5 + 5
    expect(st.totalTokens).toBe(30);
    expect(st.resolvedModel).toBe('mock-model-x');
    expect(st.promptVersion).toBeTruthy();
    expect(st.latencyMs).toBeGreaterThanOrEqual(6);
  });
});

describe('AiOrchestratorService — obsolescence & idempotence', () => {
  it('nouveau message client pendant le run → SUPERSEDED, aucune suggestion', async () => {
    script = [suggestResp('trop tard')];
    const { runId } = await newRun({ newerInbound: true });
    await orchestrator.runGeneration(runId);
    expect((await runStatus(runId)).status).toBe('SUPERSEDED');
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(0);
  });

  it('réponse humaine pendant le run → SUPERSEDED', async () => {
    script = [suggestResp('trop tard')];
    const { runId } = await newRun({ newerOutbound: true });
    await orchestrator.runGeneration(runId);
    expect((await runStatus(runId)).status).toBe('SUPERSEDED');
  });

  it('handoff déjà ouvert → run SUCCEEDED mais AUCUNE suggestion', async () => {
    script = [suggestResp('une réponse')];
    const { runId } = await newRun({ openHandoff: true });
    await orchestrator.runGeneration(runId);
    expect((await runStatus(runId)).status).toBe('SUCCEEDED');
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(0);
  });

  it('mode IA désactivé pendant le run → SUPERSEDED', async () => {
    script = [suggestResp('une réponse')];
    const { runId } = await newRun();
    envVars.AI_MODE = 'DISABLED';
    await orchestrator.runGeneration(runId);
    expect((await runStatus(runId)).status).toBe('SUPERSEDED');
  });

  it('même job rejoué → aucune seconde suggestion', async () => {
    script = [suggestResp('la seule réponse')];
    const { runId } = await newRun();
    await orchestrator.runGeneration(runId);
    await orchestrator.runGeneration(runId); // rejoué : run déjà SUCCEEDED
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(1);
  });
});

describe('AiOrchestratorService — erreurs provider', () => {
  it('RETRYABLE → run relâché en QUEUED + rethrow (BullMQ retente)', async () => {
    script = [() => Promise.reject(new AiProviderError('boom', 'X', 'RETRYABLE'))];
    const { runId } = await newRun();
    await expect(orchestrator.runGeneration(runId)).rejects.toBeInstanceOf(AiProviderError);
    expect((await runStatus(runId)).status).toBe('QUEUED');
  });

  it('CONFIGURATION_ERROR → run FAILED sans rethrow', async () => {
    script = [() => Promise.reject(new AiProviderError('bad key', 'GEMINI_HTTP_401', 'CONFIGURATION_ERROR'))];
    const { runId } = await newRun();
    await orchestrator.runGeneration(runId);
    expect((await runStatus(runId)).status).toBe('FAILED');
  });
});
