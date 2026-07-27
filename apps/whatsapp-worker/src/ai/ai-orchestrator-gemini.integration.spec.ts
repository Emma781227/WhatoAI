import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';

import type { ConfigService } from '@nestjs/config';
import { GeminiAiProvider } from '@whauto/ai';
import { PrismaClient } from '@whauto/database';

import { AiContextService } from './ai-context.service';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AiOutboundSenderService } from './ai-outbound-sender.service';
import type { AiProviderFactory } from './ai-provider.factory';
import type { AiRealtimeEmitter } from './ai-realtime-emitter.service';
import { AiToolExecutor } from './tools/tool-executor';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Orchestrateur exercé avec le VRAI GeminiAiProvider pointé vers un faux serveur
 * Gemini local (ajustement 15) : functionCall réel → outil exécuté →
 * functionResponse → sortie structurée finale ; usage cumulé ; erreur provider
 * au 2ᵉ tour ; réponse finale invalide.
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

// --- Faux serveur Gemini : file de réponses successives ---------------------
let server: Server;
let baseUrl: string;
let responses: Array<{ status: number; body: unknown }> = [];
let responseIndex = 0;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const next = responses[responseIndex++] ?? { status: 500, body: { error: { status: 'NO_SCRIPT' } } };
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const org = await prisma.organization.create({ data: { name: SUFFIX, slug: SUFFIX }, select: { id: true } });
  ids.org = org.id;
  const shop = await prisma.shop.create({
    data: { organizationId: org.id, name: 'S', slug: `s-${SUFFIX}`, status: 'ACTIVE', countryCode: 'CM', timezone: 'Africa/Douala', currency: 'XAF', locale: 'fr' },
    select: { id: true },
  });
  ids.shop = shop.id;
  const channel = await prisma.whatsAppChannel.create({
    data: { organizationId: org.id, shopId: shop.id, provider: 'META_CLOUD', status: 'CONNECTED', displayName: 'C', phoneNumber: '+1' },
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
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const org = ids.org;
  await prisma.aiToolCall.deleteMany({ where: { organizationId: org } });
  await prisma.aiSuggestion.deleteMany({ where: { organizationId: org } });
  await prisma.conversationHandoff.deleteMany({ where: { organizationId: org } });
  await prisma.aiRun.deleteMany({ where: { organizationId: org } });
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

const envVars: Record<string, unknown> = {
  AI_MODE: 'SUGGEST_ONLY',
  AI_MAX_OUTPUT_TOKENS: 300,
  AI_CONTEXT_MAX_MESSAGES: 20,
  AI_TOOL_MAX_ROUNDS: 4,
  AI_REQUEST_TIMEOUT_MS: 5000,
};
const config = { get: (k: string) => envVars[k] } as unknown as ConfigService;
const emitter = { emitToOrganization: () => undefined } as unknown as AiRealtimeEmitter;

let geminiProvider: GeminiAiProvider;
const factory = { getProvider: () => geminiProvider } as unknown as AiProviderFactory;
const outboundSender = new AiOutboundSenderService(
  P,
  emitter,
  { add: async () => undefined } as unknown as ConstructorParameters<typeof AiOutboundSenderService>[2],
);
const orchestrator = new AiOrchestratorService(P, config, new AiContextService(P), factory, new AiToolExecutor(P), emitter, outboundSender);

const ids: Record<string, string> = {};
const SUFFIX = `aigem-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let counter = 0;

beforeEach(() => {
  responses = [];
  responseIndex = 0;
  geminiProvider = new GeminiAiProvider({ apiKey: 'K', model: 'gemini-x', baseUrl, apiVersion: 'v1beta', timeoutMs: 3000 });
});

function structuredBody(action: string, fields: Record<string, unknown>) {
  const text = JSON.stringify({ action, replyText: null, handoffReason: null, confidence: 0.8, usedBusinessData: true, ...fields });
  return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 }, modelVersion: 'gemini-x-002' };
}
function functionCallBody(name: string, args: Record<string, unknown>) {
  return { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name, args } }] } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, totalTokenCount: 40 } };
}

async function newRun(): Promise<string> {
  counter += 1;
  const phone = `+15550${String(100000 + counter).slice(-6)}`;
  const contact = await prisma.contact.create({ data: { organizationId: ids.org, shopId: ids.shop, whatsappPhone: phone, normalizedPhone: phone }, select: { id: true } });
  const conversation = await prisma.conversation.create({ data: { organizationId: ids.org, shopId: ids.shop, channelId: ids.channel, contactId: contact.id, status: 'OPEN' }, select: { id: true } });
  const anchor = await prisma.message.create({ data: { organizationId: ids.org, shopId: ids.shop, conversationId: conversation.id, channelId: ids.channel, contactId: contact.id, direction: 'INBOUND', type: 'TEXT', status: 'RECEIVED', senderType: 'CUSTOMER', textContent: 'Avez-vous des sacs ?' }, select: { id: true } });
  const run = await prisma.aiRun.create({ data: { organizationId: ids.org, shopId: ids.shop, conversationId: conversation.id, triggerMessageId: anchor.id, contextLastMessageId: anchor.id, provider: 'GEMINI', model: 'gemini-x', mode: 'SUGGEST_ONLY', status: 'QUEUED' }, select: { id: true } });
  return run.id;
}

async function runStatus(runId: string) {
  return prisma.aiRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true, inputTokens: true, totalTokens: true, resolvedModel: true, toolRounds: true } });
}

describe('Orchestrateur + faux serveur Gemini', () => {
  it('functionCall réel → outil exécuté → functionResponse → sortie structurée finale', async () => {
    responses = [
      { status: 200, body: functionCallBody('search_products', { query: 'sac' }) },
      { status: 200, body: structuredBody('SUGGEST_REPLY', { replyText: 'Oui, le Sac Rouge est disponible.' }) },
    ];
    const runId = await newRun();
    await orchestrator.runGeneration(runId);

    const st = await runStatus(runId);
    expect(st.status).toBe('SUCCEEDED');
    expect(st.toolRounds).toBe(1);
    expect(st.resolvedModel).toBe('gemini-x-002');
    const suggestion = await prisma.aiSuggestion.findFirst({ where: { aiRunId: runId } });
    expect(suggestion?.content).toContain('Sac Rouge');
    const call = await prisma.aiToolCall.findFirst({ where: { aiRunId: runId }, select: { toolName: true, status: true } });
    expect(call).toMatchObject({ toolName: 'search_products', status: 'SUCCEEDED' });
  });

  it('usage cumulé sur les deux tours', async () => {
    responses = [
      { status: 200, body: functionCallBody('get_shop_opening_hours', {}) },
      { status: 200, body: structuredBody('SUGGEST_REPLY', { replyText: 'Nous ouvrons bientôt.' }) },
    ];
    const runId = await newRun();
    await orchestrator.runGeneration(runId);
    const st = await runStatus(runId);
    expect(st.inputTokens).toBe(80); // 30 + 50
    expect(st.totalTokens).toBe(110); // 40 + 70
  });

  it('erreur provider au 2ᵉ tour (500) → RETRYABLE → run relâché en QUEUED', async () => {
    responses = [
      { status: 200, body: functionCallBody('search_products', { query: 'sac' }) },
      { status: 500, body: { error: { status: 'INTERNAL' } } },
    ];
    const runId = await newRun();
    await expect(orchestrator.runGeneration(runId)).rejects.toBeTruthy();
    expect((await runStatus(runId)).status).toBe('QUEUED');
  });

  it('réponse finale invalide (non structurée) deux fois → run FAILED', async () => {
    const invalid = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'coucou' }] } }] };
    responses = [
      { status: 200, body: invalid },
      { status: 200, body: invalid },
    ];
    const runId = await newRun();
    await orchestrator.runGeneration(runId);
    expect((await runStatus(runId)).status).toBe('FAILED');
  });
});
