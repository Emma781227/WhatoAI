import { readFileSync } from 'node:fs';

import type { ConfigService } from '@nestjs/config';
import type { AiProvider, AiProviderResponse } from '@whauto/ai';
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

/**
 * Tests d'INTÉGRATION du chemin AUTO_REPLY (sous-phase C, C2) contre la vraie
 * base. Provider MOCK scripté ; la queue outbound est CAPTURÉE (pas de Redis).
 * Vérifie la porte d'auto-envoi (SEND vs SUPPRESS→repli suggestion vs ESCALATED)
 * et la traçabilité (autoReplyDecision, audits). Un run n'auto-envoie JAMAIS et
 * ne suggère JAMAIS en même temps qu'un handoff ouvert.
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
  AI_MODE: 'SUGGEST_ONLY', // le mode AUTO_REPLY vient de la config Shop.
  AI_MAX_OUTPUT_TOKENS: 300,
  AI_CONTEXT_MAX_MESSAGES: 20,
  AI_TOOL_MAX_ROUNDS: 4,
  AI_REQUEST_TIMEOUT_MS: 5000,
  // Scénarios d'AUTO_REPLY : le résumé (CI-G2) est coupé pour ne pas consommer
  // le script de réponses du provider.
  AI_SUMMARY_ENABLED: false,
};
const config = { get: (k: string) => envVars[k] } as unknown as ConfigService;

const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
const emitter = {
  emitToOrganization: (_org: string, event: string, payload: Record<string, unknown>) =>
    events.push({ event, payload }),
} as unknown as AiRealtimeEmitter;

// Queue outbound capturée.
const queueAdds: Array<{ name: string; data: { messageId: string; dispatchId: string }; opts: { jobId?: string } }> = [];
const queue = {
  add: async (name: string, data: { messageId: string; dispatchId: string }, opts: { jobId?: string }) => {
    queueAdds.push({ name, data, opts });
  },
} as unknown as ConstructorParameters<typeof AiOutboundSenderService>[2];

let script: AiProviderResponse[] = [];
let scriptIndex = 0;
const scripted: AiProvider = {
  getProviderName: () => 'MOCK',
  generateSuggestion: async () => script[scriptIndex++],
  continueWithToolResults: async () => script[scriptIndex++],
  validateConfiguration: async () => ({ ok: true }),
  summarizeConversation: async () => script[scriptIndex++],
};
const factory = { getProvider: () => scripted } as unknown as AiProviderFactory;

const outboundSender = new AiOutboundSenderService(P, emitter, queue);
const orchestrator = new AiOrchestratorService(
  P,
  config,
  new AiContextService(P),
  new AiSummaryService(P, config),
  factory,
  new AiToolExecutor(P),
  emitter,
  outboundSender,
  new WalletReservationService(P),
);

function resp(partial: Partial<AiProviderResponse> & { text: string | null }): AiProviderResponse {
  return {
    toolCalls: [],
    finishReason: 'STOP',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    latencyMs: 3,
    modelVersion: 'mock-model-x',
    ...partial,
  };
}
function structured(action: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ action, replyText: null, handoffReason: null, confidence: 0.9, usedBusinessData: false, ...fields });
}
const suggest = (text: string, opts: { confidence?: number; usedBusinessData?: boolean } = {}) =>
  resp({ text: structured('SUGGEST_REPLY', { replyText: text, confidence: opts.confidence ?? 0.9, usedBusinessData: opts.usedBusinessData ?? false }) });
const handoff = (reason: string) => resp({ text: structured('HANDOFF', { handoffReason: reason }) });
const tool = (name: string, args: Record<string, unknown>): AiProviderResponse =>
  resp({ text: null, finishReason: 'TOOL_CALLS', toolCalls: [{ id: `${name}-0`, name, arguments: args }] });

const ids: Record<string, string> = {};
const SUFFIX = `aiauto-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function setConfig(partial: {
  autoReplyEnabled?: boolean;
  mode?: 'AUTO_REPLY' | 'SUGGEST_ONLY';
  autoReplyAllowedCategories?: string[];
  autoReplyMaxPerConversationPerDay?: number;
}): Promise<void> {
  await prisma.aiConfiguration.update({
    where: { shopId: ids.shop },
    data: {
      mode: partial.mode ?? 'AUTO_REPLY',
      autoReplyEnabled: partial.autoReplyEnabled ?? true,
      ...(partial.autoReplyAllowedCategories ? { autoReplyAllowedCategories: partial.autoReplyAllowedCategories } : {}),
      ...(partial.autoReplyMaxPerConversationPerDay !== undefined
        ? { autoReplyMaxPerConversationPerDay: partial.autoReplyMaxPerConversationPerDay }
        : {}),
    },
  });
}

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
  await prisma.aiConfiguration.create({
    data: { organizationId: org.id, shopId: shop.id, provider: 'MOCK', mode: 'AUTO_REPLY', autoReplyEnabled: true },
  });
});

afterAll(async () => {
  const org = ids.org;
  await prisma.organizationAuditEvent.deleteMany({ where: { organizationId: org } });
  await prisma.aiToolCall.deleteMany({ where: { organizationId: org } });
  await prisma.aiSuggestion.deleteMany({ where: { organizationId: org } });
  await prisma.conversationHandoff.deleteMany({ where: { organizationId: org } });
  await prisma.aiConfiguration.deleteMany({ where: { organizationId: org } });
  await prisma.aiRun.deleteMany({ where: { organizationId: org } });
  await prisma.outboxEvent.deleteMany({ where: { organizationId: org } });
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

beforeEach(async () => {
  script = [];
  scriptIndex = 0;
  events.length = 0;
  queueAdds.length = 0;
  // Config par défaut AUTO_REPLY activée, liste blanche complète.
  await prisma.aiConfiguration.update({
    where: { shopId: ids.shop },
    data: {
      mode: 'AUTO_REPLY',
      autoReplyEnabled: true,
      autoReplyScheduleMode: 'ALWAYS',
      autoReplyMaxPerConversationPerDay: 5,
      autoReplyAllowedCategories: ['PRODUCT_INFO', 'AVAILABILITY', 'OPENING_HOURS', 'ORDER_STATUS'],
    },
  });
});

let runCounter = 0;
async function newRun(opts: { windowClosed?: boolean; priorAiOutbound?: number; paused?: boolean } = {}): Promise<{ runId: string; conversationId: string }> {
  runCounter += 1;
  const phone = `+2377${String(10000000 + runCounter).slice(-8)}`;
  const contact = await prisma.contact.create({
    data: { organizationId: ids.org, shopId: ids.shop, whatsappPhone: phone, normalizedPhone: phone },
    select: { id: true },
  });
  const windowExpiry = opts.windowClosed ? null : new Date(Date.now() + 12 * 60 * 60 * 1000);
  const conversation = await prisma.conversation.create({
    data: {
      organizationId: ids.org,
      shopId: ids.shop,
      channelId: ids.channel,
      contactId: contact.id,
      status: 'OPEN',
      customerServiceWindowExpiresAt: windowExpiry,
      aiAutoReplyPaused: opts.paused ?? false,
    },
    select: { id: true },
  });

  // Réponses auto ANTÉRIEURES (avant l'ancre → n'obsolètent pas le run, mais
  // comptent dans le plafond journalier).
  for (let i = 0; i < (opts.priorAiOutbound ?? 0); i += 1) {
    await prisma.message.create({
      data: {
        organizationId: ids.org, shopId: ids.shop, conversationId: conversation.id, channelId: ids.channel, contactId: contact.id,
        direction: 'OUTBOUND', type: 'TEXT', status: 'SENT', senderType: 'AI', isAiGenerated: true,
        textContent: 'réponse auto antérieure', createdAt: new Date(Date.now() - (i + 1) * 60_000),
      },
    });
  }

  const anchor = await prisma.message.create({
    data: { organizationId: ids.org, shopId: ids.shop, conversationId: conversation.id, channelId: ids.channel, contactId: contact.id, direction: 'INBOUND', type: 'TEXT', status: 'RECEIVED', senderType: 'CUSTOMER', textContent: 'Bonjour' },
    select: { id: true },
  });
  const run = await prisma.aiRun.create({
    data: { organizationId: ids.org, shopId: ids.shop, conversationId: conversation.id, triggerMessageId: anchor.id, contextLastMessageId: anchor.id, provider: 'MOCK', model: 'mock-model', mode: 'AUTO_REPLY', status: 'QUEUED' },
    select: { id: true },
  });
  return { runId: run.id, conversationId: conversation.id };
}

async function auditReasons(runId: string, eventType: string): Promise<unknown[]> {
  const rows = await prisma.organizationAuditEvent.findMany({
    where: { organizationId: ids.org, eventType: eventType as never },
    select: { metadata: true },
  });
  return rows.map((r) => r.metadata).filter((m) => (m as { aiRunId?: string })?.aiRunId === runId);
}

describe('AUTO_REPLY — auto-envoi', () => {
  it('tout vert → Message OUTBOUND/AI auto-envoyé, aucune suggestion, run SENT, audit + publication', async () => {
    script = [suggest('Bonjour ! Comment puis-je vous aider ?')];
    const { runId, conversationId } = await newRun();
    await orchestrator.runGeneration(runId);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true, autoReplyDecision: true } });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.autoReplyDecision).toBe('SENT');

    const messages = await prisma.message.findMany({
      where: { conversationId, direction: 'OUTBOUND' },
      select: { status: true, senderType: true, isAiGenerated: true, aiGeneratedByRunId: true, dispatchId: true },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ status: 'PENDING', senderType: 'AI', isAiGenerated: true, aiGeneratedByRunId: runId });

    // Aucune suggestion (auto-envoi direct).
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(0);

    // C3 : la conversation passe en mode AI (badge), pas de pause.
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { mode: true, aiAutoReplyPaused: true } });
    expect(conv.mode).toBe('AI');
    expect(conv.aiAutoReplyPaused).toBe(false);

    // Publication + audit + temps réel.
    expect(queueAdds).toHaveLength(1);
    expect(queueAdds[0].opts.jobId).toBe(messages[0].dispatchId);
    expect(await auditReasons(runId, 'AI_AUTO_REPLY_SENT')).toHaveLength(1);
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['ai.run.completed', 'message.created']));
  });
});

describe('AUTO_REPLY — C3 : mode conversation & reprise humaine', () => {
  it('conversation en pause (reprise humaine) → SUPPRESSED CONVERSATION_PAUSED, aucun envoi', async () => {
    script = [suggest('Bonjour !')];
    const { runId, conversationId } = await newRun({ paused: true });
    await orchestrator.runGeneration(runId);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId }, select: { autoReplyDecision: true, autoReplySuppressionReason: true } });
    expect(run.autoReplyDecision).toBe('SUPPRESSED');
    expect(run.autoReplySuppressionReason).toBe('CONVERSATION_PAUSED');
    // Repli en suggestion (l'agent garde le brouillon), aucun envoi.
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(1);
    expect(await prisma.message.count({ where: { conversationId, direction: 'OUTBOUND' } })).toBe(0);
    expect(queueAdds).toHaveLength(0);
  });

  it('décision HANDOFF → conversation repasse en HUMAN + auto-réponse suspendue', async () => {
    script = [handoff('Demande complexe')];
    const { runId, conversationId } = await newRun();
    await orchestrator.runGeneration(runId);

    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { mode: true, aiAutoReplyPaused: true } });
    expect(conv.mode).toBe('HUMAN');
    expect(conv.aiAutoReplyPaused).toBe(true);
  });
});

describe('AUTO_REPLY — suppression (repli en suggestion)', () => {
  it('catégorie hors liste blanche → SUPPRESSED CATEGORY_NOT_ALLOWED + suggestion', async () => {
    await setConfig({ autoReplyAllowedCategories: ['ORDER_STATUS'] }); // PRODUCT_INFO retiré.
    script = [tool('search_products', { query: 'sac' }), suggest('Nous avons le Sac Rouge à 15 000 XAF.', { usedBusinessData: true })];
    const { runId, conversationId } = await newRun();
    await orchestrator.runGeneration(runId);

    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId }, select: { autoReplyDecision: true, autoReplySuppressionReason: true } });
    expect(run.autoReplyDecision).toBe('SUPPRESSED');
    expect(run.autoReplySuppressionReason).toBe('CATEGORY_NOT_ALLOWED');
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(1);
    expect(await prisma.message.count({ where: { conversationId, direction: 'OUTBOUND' } })).toBe(0);
    expect(queueAdds).toHaveLength(0);
    expect(await auditReasons(runId, 'AI_AUTO_REPLY_SUPPRESSED')).toHaveLength(1);
  });

  it('confiance sous le plancher → SUPPRESSED LOW_CONFIDENCE + suggestion', async () => {
    script = [suggest('Bonjour !', { confidence: 0.3 })];
    const { runId } = await newRun();
    await orchestrator.runGeneration(runId);
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId }, select: { autoReplyDecision: true, autoReplySuppressionReason: true } });
    expect(run.autoReplyDecision).toBe('SUPPRESSED');
    expect(run.autoReplySuppressionReason).toBe('LOW_CONFIDENCE');
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(1);
  });

  it('fenêtre 24 h fermée → SUPPRESSED WINDOW_CLOSED + suggestion, aucun envoi', async () => {
    script = [suggest('Bonjour !')];
    const { runId, conversationId } = await newRun({ windowClosed: true });
    await orchestrator.runGeneration(runId);
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId }, select: { autoReplyDecision: true, autoReplySuppressionReason: true } });
    expect(run.autoReplySuppressionReason).toBe('WINDOW_CLOSED');
    expect(await prisma.message.count({ where: { conversationId, direction: 'OUTBOUND' } })).toBe(0);
    expect(queueAdds).toHaveLength(0);
  });

  it('plafond journalier atteint → SUPPRESSED RATE_LIMIT + suggestion', async () => {
    await setConfig({ autoReplyMaxPerConversationPerDay: 1 });
    script = [suggest('Bonjour !')];
    const { runId } = await newRun({ priorAiOutbound: 1 }); // 1 réponse auto déjà dans les 24 h.
    await orchestrator.runGeneration(runId);
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId }, select: { autoReplyDecision: true, autoReplySuppressionReason: true } });
    expect(run.autoReplyDecision).toBe('SUPPRESSED');
    expect(run.autoReplySuppressionReason).toBe('RATE_LIMIT');
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(1);
  });
});

describe('AUTO_REPLY — escalade & garde-fous', () => {
  it('décision HANDOFF en AUTO_REPLY → handoff REQUESTED, run ESCALATED, aucun envoi', async () => {
    script = [handoff('Demande de remboursement')];
    const { runId, conversationId } = await newRun();
    await orchestrator.runGeneration(runId);
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId }, select: { autoReplyDecision: true } });
    expect(run.autoReplyDecision).toBe('ESCALATED');
    expect(await prisma.conversationHandoff.count({ where: { conversationId, status: 'REQUESTED' } })).toBe(1);
    expect(await prisma.message.count({ where: { conversationId, direction: 'OUTBOUND' } })).toBe(0);
    expect(await auditReasons(runId, 'AI_AUTO_REPLY_ESCALATED')).toHaveLength(1);
  });

  it('AUTO_REPLY non activé (drapeau off) → comportement SUGGEST_ONLY (suggestion, pas d envoi)', async () => {
    await setConfig({ autoReplyEnabled: false });
    script = [suggest('Bonjour !')];
    const { runId, conversationId } = await newRun();
    await orchestrator.runGeneration(runId);
    const run = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId }, select: { autoReplyDecision: true } });
    expect(run.autoReplyDecision).toBeNull();
    expect(await prisma.aiSuggestion.count({ where: { aiRunId: runId } })).toBe(1);
    expect(await prisma.message.count({ where: { conversationId, direction: 'OUTBOUND' } })).toBe(0);
    expect(queueAdds).toHaveLength(0);
  });

  it('nouveau message client pendant le run → SUPERSEDED, aucun envoi (obsolescence prime)', async () => {
    script = [suggest('trop tard')];
    const { runId, conversationId } = await newRun();
    // Message client APRÈS l'ancre (obsolescence).
    const conv = await prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { contactId: true } });
    await prisma.message.create({
      data: { organizationId: ids.org, shopId: ids.shop, conversationId, channelId: ids.channel, contactId: conv.contactId, direction: 'INBOUND', type: 'TEXT', status: 'RECEIVED', senderType: 'CUSTOMER', textContent: 'encore une question', createdAt: new Date(Date.now() + 1000) },
    });
    await orchestrator.runGeneration(runId);
    expect((await prisma.aiRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true } })).status).toBe('SUPERSEDED');
    expect(await prisma.message.count({ where: { conversationId, direction: 'OUTBOUND' } })).toBe(0);
  });
});
