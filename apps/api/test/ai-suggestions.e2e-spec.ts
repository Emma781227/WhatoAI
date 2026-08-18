// Overrides d'environnement AVANT l'import d'AppModule.
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.AUTH_EXPOSE_TEST_TOKENS = 'true';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.AI_MODE = 'SUGGEST_ONLY';
process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REGISTER_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REFRESH_MAX = '1000';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const RUN_ID = Date.now().toString(36);
const PASSWORD = 'e2e-password-123';

function email(tag: string): string {
  return `e2e-ai-${RUN_ID}-${tag}@e2e.whauto.test`;
}
function tokenFromDevLink(devLink: string): string {
  return new URL(devLink).searchParams.get('token')!;
}

interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

describe('IA — suggestions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;

  let owner: TestUser;
  let manager: TestUser;
  let agent: TestUser;
  let orgId: string;
  let orgBId: string;
  let shopId: string;
  let channelId: string;
  let contactId: string;
  let conversationId: string;
  let anchorMessageId: string;

  async function verifiedUser(tag: string): Promise<TestUser> {
    const userEmail = email(tag);
    const reg = await request(server)
      .post('/api/auth/register')
      .send({ email: userEmail, password: PASSWORD, firstName: 'T', lastName: tag });
    const verifyToken = tokenFromDevLink(reg.body.devLink);
    await request(server).post('/api/auth/verify-email').send({ token: verifyToken });
    const login = await request(server)
      .post('/api/auth/login')
      .send({ email: userEmail, password: PASSWORD });
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: userEmail },
      select: { id: true },
    });
    return { id: user.id, email: userEmail, accessToken: login.body.accessToken };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);

    owner = await verifiedUser('owner');
    manager = await verifiedUser('manager');
    agent = await verifiedUser('agent');

    const orgRes = await request(server)
      .post('/api/organizations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: `AI Org ${RUN_ID}` });
    orgId = orgRes.body.organization.id;

    const orgBRes = await request(server)
      .post('/api/organizations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: `AI OrgB ${RUN_ID}` });
    orgBId = orgBRes.body.organization.id;

    // Memberships MANAGER/AGENT seedés directement (bypass invitation).
    await prisma.membership.create({
      data: { userId: manager.id, organizationId: orgId, role: 'MANAGER', status: 'ACTIVE' },
    });
    await prisma.membership.create({
      data: { userId: agent.id, organizationId: orgId, role: 'AGENT', status: 'ACTIVE' },
    });

    const shop = await prisma.shop.create({
      data: {
        organizationId: orgId,
        name: 'Shop',
        slug: `shop-${RUN_ID}`,
        status: 'ACTIVE',
        countryCode: 'CM',
        timezone: 'Africa/Douala',
        currency: 'XAF',
        locale: 'fr',
      },
      select: { id: true },
    });
    shopId = shop.id;
    const channel = await prisma.whatsAppChannel.create({
      data: {
        organizationId: orgId,
        shopId,
        provider: 'MOCK',
        status: 'CONNECTED',
        displayName: 'C',
        phoneNumber: '+237600000000',
      },
      select: { id: true },
    });
    channelId = channel.id;
    const contact = await prisma.contact.create({
      data: { organizationId: orgId, shopId, whatsappPhone: '+237600000001', normalizedPhone: '+237600000001' },
      select: { id: true },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Crée un contact frais + conversation OPEN + message ancre + AiRun + AiSuggestion PENDING. */
  let seedCounter = 0;
  async function seedSuggestion(content = 'Bonjour, oui nous avons des sacs !'): Promise<{
    conversationId: string;
    anchorMessageId: string;
    suggestionId: string;
  }> {
    // Contact frais : l'index partiel n'autorise qu'UNE conversation active par
    // (channel, contact).
    seedCounter += 1;
    const phone = `+2377${String(10000000 + seedCounter).slice(-8)}`;
    const contact = await prisma.contact.create({
      data: { organizationId: orgId, shopId, whatsappPhone: phone, normalizedPhone: phone },
      select: { id: true },
    });
    const contactId = contact.id;
    const conversation = await prisma.conversation.create({
      data: {
        organizationId: orgId,
        shopId,
        channelId,
        contactId,
        status: 'OPEN',
        customerServiceWindowExpiresAt: new Date(Date.now() + 3600_000),
      },
      select: { id: true },
    });
    const anchor = await prisma.message.create({
      data: {
        organizationId: orgId,
        shopId,
        conversationId: conversation.id,
        channelId,
        contactId,
        direction: 'INBOUND',
        type: 'TEXT',
        status: 'RECEIVED',
        senderType: 'CUSTOMER',
        textContent: 'Vous avez des sacs ?',
      },
      select: { id: true },
    });
    const run = await prisma.aiRun.create({
      data: {
        organizationId: orgId,
        shopId,
        conversationId: conversation.id,
        triggerMessageId: anchor.id,
        contextLastMessageId: anchor.id,
        provider: 'MOCK',
        model: 'mock-model',
        mode: 'SUGGEST_ONLY',
        status: 'SUCCEEDED',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        resolvedModel: 'mock-model-x',
      },
      select: { id: true },
    });
    const suggestion = await prisma.aiSuggestion.create({
      data: {
        aiRunId: run.id,
        organizationId: orgId,
        shopId,
        conversationId: conversation.id,
        content,
        status: 'PENDING',
        contextLastMessageId: anchor.id,
      },
      select: { id: true },
    });
    return { conversationId: conversation.id, anchorMessageId: anchor.id, suggestionId: suggestion.id };
  }

  const authOwner = () => ({ Authorization: `Bearer ${owner.accessToken}` });
  const authManager = () => ({ Authorization: `Bearer ${manager.accessToken}` });
  const authAgent = () => ({ Authorization: `Bearer ${agent.accessToken}` });
  const suggBase = (conv: string) => `/api/organizations/${orgId}/conversations/${conv}/ai/suggestions`;

  // ---------------------------------------------------------------- config

  it('configuration : GET (AGENT autorisé, lecture) et PATCH refusé à l’AGENT', async () => {
    const get = await request(server)
      .get(`/api/organizations/${orgId}/shops/${shopId}/ai/configuration`)
      .set(authAgent());
    expect(get.status).toBe(200);
    expect(get.body).not.toHaveProperty('apiKey');
    expect(JSON.stringify(get.body)).not.toMatch(/key|secret|prompt/i);

    const patch = await request(server)
      .patch(`/api/organizations/${orgId}/shops/${shopId}/ai/configuration`)
      .set(authAgent())
      .send({ mode: 'SUGGEST_ONLY', expectedVersion: get.body.version });
    expect(patch.status).toBe(403);
  });

  it('MANAGER configure mais NE peut PAS activer AUTO_REPLY (403)', async () => {
    const get = await request(server)
      .get(`/api/organizations/${orgId}/shops/${shopId}/ai/configuration`)
      .set(authManager());
    const ok = await request(server)
      .patch(`/api/organizations/${orgId}/shops/${shopId}/ai/configuration`)
      .set(authManager())
      .send({ mode: 'SUGGEST_ONLY', expectedVersion: get.body.version });
    expect(ok.status).toBe(200);

    const auto = await request(server)
      .patch(`/api/organizations/${orgId}/shops/${shopId}/ai/configuration`)
      .set(authManager())
      .send({ mode: 'AUTO_REPLY', expectedVersion: ok.body.version });
    expect(auto.status).toBe(403);
  });

  // ---------------------------------------------------------------- accept

  it('accept inchangé → ACCEPTED + UN SEUL Message outbound + outbox', async () => {
    const s = await seedSuggestion('Réponse IA originale');
    const res = await request(server)
      .post(`${suggBase(s.conversationId)}/${s.suggestionId}/accept`)
      .set(authAgent())
      .send({ content: 'Réponse IA originale', expectedVersion: 0 });
    expect(res.status).toBe(201);
    expect(res.body.suggestion.status).toBe('ACCEPTED');

    const messages = await prisma.message.findMany({
      where: { conversationId: s.conversationId, direction: 'OUTBOUND' },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].textContent).toBe('Réponse IA originale');
    const outbox = await prisma.outboxEvent.count({ where: { organizationId: orgId } });
    expect(outbox).toBeGreaterThan(0);
    const sug = await prisma.aiSuggestion.findUniqueOrThrow({ where: { id: s.suggestionId } });
    expect(sug.sentMessageId).toBe(messages[0].id);
  });

  it('accept modifié → EDITED_AND_ACCEPTED + le contenu ENVOYÉ est celui du payload', async () => {
    const s = await seedSuggestion('Version IA');
    const res = await request(server)
      .post(`${suggBase(s.conversationId)}/${s.suggestionId}/accept`)
      .set(authAgent())
      .send({ content: 'Version corrigée par l’agent', expectedVersion: 0 });
    expect(res.status).toBe(201);
    expect(res.body.suggestion.status).toBe('EDITED_AND_ACCEPTED');
    const msg = await prisma.message.findFirstOrThrow({
      where: { conversationId: s.conversationId, direction: 'OUTBOUND' },
    });
    expect(msg.textContent).toBe('Version corrigée par l’agent');
  });

  it('double accept concurrent : un seul réussit, l’autre 409 ALREADY_HANDLED, jamais 2 messages', async () => {
    const s = await seedSuggestion();
    const [a, b] = await Promise.all([
      request(server).post(`${suggBase(s.conversationId)}/${s.suggestionId}/accept`).set(authAgent()).send({ content: 'x', expectedVersion: 0 }),
      request(server).post(`${suggBase(s.conversationId)}/${s.suggestionId}/accept`).set(authAgent()).send({ content: 'x', expectedVersion: 0 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const conflict = a.status === 409 ? a : b;
    expect(conflict.body.code).toBe('AI_SUGGESTION_ALREADY_HANDLED');
    const messages = await prisma.message.count({ where: { conversationId: s.conversationId, direction: 'OUTBOUND' } });
    expect(messages).toBe(1);
  });

  it('mauvaise version → 409 VERSION_CONFLICT', async () => {
    const s = await seedSuggestion();
    const res = await request(server)
      .post(`${suggBase(s.conversationId)}/${s.suggestionId}/accept`)
      .set(authAgent())
      .send({ content: 'x', expectedVersion: 99 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AI_SUGGESTION_VERSION_CONFLICT');
  });

  // ---------------------------------------------------------------- stale

  it('stale (nouveau message client) sans confirmation → 409 STALE canConfirm ; avec confirmStale → envoyé', async () => {
    const s = await seedSuggestion();
    // Nouveau message client APRÈS l'ancre.
    await prisma.message.create({
      data: {
        organizationId: orgId,
        shopId,
        conversationId: s.conversationId,
        channelId,
        contactId,
        direction: 'INBOUND',
        type: 'TEXT',
        status: 'RECEIVED',
        senderType: 'CUSTOMER',
        textContent: 'en fait je voulais autre chose',
      },
    });

    const stale = await request(server)
      .post(`${suggBase(s.conversationId)}/${s.suggestionId}/accept`)
      .set(authAgent())
      .send({ content: 'x', expectedVersion: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('AI_SUGGESTION_STALE');
    expect(stale.body.details?.canConfirm).toBe(true);

    const confirmed = await request(server)
      .post(`${suggBase(s.conversationId)}/${s.suggestionId}/accept`)
      .set(authAgent())
      .send({ content: 'x', expectedVersion: 0, confirmStale: true });
    expect(confirmed.status).toBe(201);
  });

  // ---------------------------------------------------------------- reject

  it('rejet → REJECTED, aucun message ; double rejet → 409', async () => {
    const s = await seedSuggestion();
    const r1 = await request(server)
      .post(`${suggBase(s.conversationId)}/${s.suggestionId}/reject`)
      .set(authAgent())
      .send({ expectedVersion: 0, reason: 'hors sujet' });
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe('REJECTED');
    const messages = await prisma.message.count({ where: { conversationId: s.conversationId, direction: 'OUTBOUND' } });
    expect(messages).toBe(0);

    const r2 = await request(server)
      .post(`${suggBase(s.conversationId)}/${s.suggestionId}/reject`)
      .set(authAgent())
      .send({ expectedVersion: 1 });
    expect(r2.status).toBe(409);
  });

  // ---------------------------------------------------------------- generate

  it('génération manuelle idempotente : renvoie la suggestion PENDING existante', async () => {
    const s = await seedSuggestion();
    const res = await request(server)
      .post(`${suggBase(s.conversationId)}/generate`)
      .set(authAgent())
      .send({});
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('EXISTING_SUGGESTION');
    expect(res.body.suggestion.id).toBe(s.suggestionId);
  });

  it('génération bloquée si un handoff est ouvert (409)', async () => {
    const s = await seedSuggestion();
    await prisma.conversationHandoff.create({
      data: { organizationId: orgId, shopId, conversationId: s.conversationId, status: 'REQUESTED', reason: 'x' },
    });
    const res = await request(server)
      .post(`${suggBase(s.conversationId)}/generate`)
      .set(authAgent())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AI_CONVERSATION_IN_HANDOFF');
  });

  it('génération manuelle avec solde insuffisant → 409 INSUFFICIENT_CREDITS (groupe 4)', async () => {
    // Le Wallet de l'org e2e est à 0 crédit (provisionné à la création). Une
    // conversation avec un message entrant SANS run/suggestion atteint le
    // pré-contrôle crédits juste avant l'enqueue.
    seedCounter += 1;
    const phone = `+2378${String(10000000 + seedCounter).slice(-8)}`;
    const contact = await prisma.contact.create({
      data: { organizationId: orgId, shopId, whatsappPhone: phone, normalizedPhone: phone },
      select: { id: true },
    });
    const conversation = await prisma.conversation.create({
      data: { organizationId: orgId, shopId, channelId, contactId: contact.id, status: 'OPEN', customerServiceWindowExpiresAt: new Date(Date.now() + 3600_000) },
      select: { id: true },
    });
    await prisma.message.create({
      data: { organizationId: orgId, shopId, conversationId: conversation.id, channelId, contactId: contact.id, direction: 'INBOUND', type: 'TEXT', status: 'RECEIVED', senderType: 'CUSTOMER', textContent: 'Bonjour' },
      select: { id: true },
    });

    const res = await request(server)
      .post(`${suggBase(conversation.id)}/generate`)
      .set(authAgent())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
    expect(res.body.details).toMatchObject({ availableCredits: 0, requiredCredits: 3, canTopUp: true });
    // Aucune réservation créée (pré-contrôle en lecture seule).
    expect(await prisma.aiRun.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  // ------------------------------------------------------------ cross-tenant

  it('cross-tenant : accéder à une suggestion via une autre organisation → 404', async () => {
    const s = await seedSuggestion();
    const res = await request(server)
      .get(`/api/organizations/${orgBId}/conversations/${s.conversationId}/ai/suggestions`)
      .set(authOwner());
    // La conversation n'appartient pas à orgB → 404.
    expect(res.status).toBe(404);
  });

  it('DTO run : l’AGENT (sans ai.viewRuns) ne voit aucun détail technique', async () => {
    const s = await seedSuggestion();
    const res = await request(server)
      .get(`/api/organizations/${orgId}/conversations/${s.conversationId}/ai/runs`)
      .set(authAgent());
    expect(res.status).toBe(200);
    const run = res.body.items[0];
    expect(run.totalTokens).toBeNull();
    expect(run.resolvedModel).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/prompt|apiKey|secret/i);

    const asManager = await request(server)
      .get(`/api/organizations/${orgId}/conversations/${s.conversationId}/ai/runs`)
      .set(authManager());
    expect(asManager.body.items[0].totalTokens).toBe(15);
  });

  // ------------------------------------------------- C4 : config auto-reply

  const configUrl = () => `/api/organizations/${orgId}/shops/${shopId}/ai/configuration`;
  async function currentVersion(auth: Record<string, string>): Promise<number> {
    const get = await request(server).get(configUrl()).set(auth);
    return get.body.version as number;
  }

  it('config expose les garde-fous AUTO_REPLY et les accepte (schedule/plafond/catégories)', async () => {
    const version = await currentVersion(authOwner());
    const patch = await request(server)
      .patch(configUrl())
      .set(authOwner())
      .send({
        autoReplyScheduleMode: 'OUTSIDE_BUSINESS_HOURS',
        autoReplyMaxPerConversationPerDay: 3,
        autoReplyAllowedCategories: ['PRODUCT_INFO', 'AVAILABILITY'],
        expectedVersion: version,
      });
    expect(patch.status).toBe(200);
    expect(patch.body.autoReplyScheduleMode).toBe('OUTSIDE_BUSINESS_HOURS');
    expect(patch.body.autoReplyMaxPerConversationPerDay).toBe(3);
    expect(patch.body.autoReplyAllowedCategories).toEqual(['PRODUCT_INFO', 'AVAILABILITY']);

    const get = await request(server).get(configUrl()).set(authOwner());
    expect(get.body.autoReplyMaxPerConversationPerDay).toBe(3);
  });

  it('MANAGER configure les garde-fous SANS activer (les réglages ≠ activation)', async () => {
    const version = await currentVersion(authManager());
    const patch = await request(server)
      .patch(configUrl())
      .set(authManager())
      .send({ autoReplyMaxPerConversationPerDay: 7, expectedVersion: version });
    expect(patch.status).toBe(200);
    expect(patch.body.autoReplyMaxPerConversationPerDay).toBe(7);
  });

  it('catégorie invalide → 400', async () => {
    const version = await currentVersion(authOwner());
    const patch = await request(server)
      .patch(configUrl())
      .set(authOwner())
      .send({ autoReplyAllowedCategories: ['NOT_A_CATEGORY'], expectedVersion: version });
    expect(patch.status).toBe(400);
  });

  it('OWNER active AUTO_REPLY (autoReplyEnabled) — permission ai.enableAutoReply', async () => {
    const version = await currentVersion(authOwner());
    const patch = await request(server)
      .patch(configUrl())
      .set(authOwner())
      .send({ mode: 'AUTO_REPLY', autoReplyEnabled: true, expectedVersion: version });
    expect(patch.status).toBe(200);
    expect(patch.body.autoReplyEnabled).toBe(true);
    expect(patch.body.mode).toBe('AUTO_REPLY');
    // Remise en SUGGEST_ONLY pour ne pas influencer d'autres tests.
    await request(server)
      .patch(configUrl())
      .set(authOwner())
      .send({ mode: 'SUGGEST_ONLY', autoReplyEnabled: false, expectedVersion: patch.body.version });
  });

  it('outils panier de l’assistant : activés par défaut, coupables sans toucher au mode (W3)', async () => {
    const initial = await request(server).get(configUrl()).set(authOwner());
    expect(initial.status).toBe(200);
    // Défaut validé : le panier est réversible et corrigeable par un agent.
    expect(initial.body.cartToolsEnabled).toBe(true);

    const off = await request(server)
      .patch(configUrl())
      .set(authOwner())
      .send({ cartToolsEnabled: false, expectedVersion: initial.body.version });
    expect(off.status).toBe(200);
    expect(off.body.cartToolsEnabled).toBe(false);
    // Couper le panier ne touche NI le mode NI l'auto-réponse.
    expect(off.body.mode).toBe(initial.body.mode);
    expect(off.body.autoReplyEnabled).toBe(initial.body.autoReplyEnabled);

    // Réactivation (restaure l'état par défaut pour les tests suivants).
    const on = await request(server)
      .patch(configUrl())
      .set(authOwner())
      .send({ cartToolsEnabled: true, expectedVersion: off.body.version });
    expect(on.status).toBe(200);
    expect(on.body.cartToolsEnabled).toBe(true);
  });

  // -------------------------------------------------- C4 : pause / reprise

  const autoReplyBase = (conv: string) =>
    `/api/organizations/${orgId}/conversations/${conv}/ai/auto-reply`;

  it('AGENT peut suspendre puis reprendre l’auto-réponse (mode + drapeau + audit)', async () => {
    const s = await seedSuggestion();

    const pause = await request(server).post(`${autoReplyBase(s.conversationId)}/pause`).set(authAgent());
    expect([200, 201]).toContain(pause.status);
    expect(pause.body.aiAutoReplyPaused).toBe(true);
    expect(pause.body.mode).toBe('HUMAN');

    const afterPause = await prisma.conversation.findUniqueOrThrow({
      where: { id: s.conversationId },
      select: { aiAutoReplyPaused: true },
    });
    expect(afterPause.aiAutoReplyPaused).toBe(true);

    // Idempotent : re-pause ne casse rien.
    const rePause = await request(server).post(`${autoReplyBase(s.conversationId)}/pause`).set(authAgent());
    expect(rePause.body.aiAutoReplyPaused).toBe(true);

    const resume = await request(server).post(`${autoReplyBase(s.conversationId)}/resume`).set(authAgent());
    expect(resume.body.aiAutoReplyPaused).toBe(false);
    expect(resume.body.mode).toBe('AI');

    const audits = await prisma.organizationAuditEvent.findMany({
      where: { organizationId: orgId, eventType: { in: ['AI_AUTO_REPLY_PAUSED', 'AI_AUTO_REPLY_RESUMED'] } },
      select: { eventType: true, metadata: true },
    });
    const forConv = audits.filter((a) => (a.metadata as { conversationId?: string })?.conversationId === s.conversationId);
    expect(forConv.map((a) => a.eventType).sort()).toEqual(['AI_AUTO_REPLY_PAUSED', 'AI_AUTO_REPLY_RESUMED']);
  });

  it('pause d’une conversation via une AUTRE organisation → 404', async () => {
    const s = await seedSuggestion();
    const res = await request(server)
      .post(`/api/organizations/${orgBId}/conversations/${s.conversationId}/ai/auto-reply/pause`)
      .set(authOwner());
    expect(res.status).toBe(404);
  });
});
