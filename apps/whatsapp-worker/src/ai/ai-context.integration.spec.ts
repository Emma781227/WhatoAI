import { readFileSync } from 'node:fs';

import { PrismaClient } from '@whauto/database';

import { AiContextService } from './ai-context.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Tests d'INTÉGRATION du contexte conversationnel (vraie base). Prouve que l'IA
 * « maintient une conversation » : le contexte inclut les tours précédents (client
 * ET boutique, y compris les réponses IA), dans l'ordre chronologique, borné par
 * contextMaxMessages, en excluant notes internes et médias.
 */

jest.setTimeout(60000);

function databaseUrl(): string {
  const raw = readFileSync('C:/Users/Emma/Desktop/Whauto AI/.env', 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL introuvable');
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
const service = new AiContextService(prisma as unknown as PrismaService);
const SUFFIX = `aictx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ids: Record<string, string> = {};

const base = new Date('2026-07-27T10:00:00.000Z').getTime();
let seq = 0;

/** Ajoute un message avec un createdAt strictement croissant (ordre garanti). */
async function addMessage(
  direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL',
  senderType: 'CUSTOMER' | 'AGENT' | 'AI',
  type: string,
  textContent: string | null,
): Promise<string> {
  seq += 1;
  const m = await prisma.message.create({
    data: {
      organizationId: ids.org,
      shopId: ids.shop,
      conversationId: ids.conversation,
      channelId: ids.channel,
      contactId: ids.contact,
      direction,
      type: type as never,
      status: direction === 'INBOUND' ? 'RECEIVED' : 'SENT',
      senderType,
      textContent,
      createdAt: new Date(base + seq * 1000),
    },
    select: { id: true },
  });
  return m.id;
}

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: SUFFIX, slug: SUFFIX }, select: { id: true } });
  ids.org = org.id;
  const shop = await prisma.shop.create({
    data: { organizationId: org.id, name: 'Boutique Awa', slug: `s-${SUFFIX}`, status: 'ACTIVE', countryCode: 'CM', timezone: 'Africa/Douala', currency: 'XAF', locale: 'fr' },
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
  const conversation = await prisma.conversation.create({
    data: { organizationId: org.id, shopId: shop.id, channelId: channel.id, contactId: contact.id, status: 'OPEN' },
    select: { id: true },
  });
  ids.conversation = conversation.id;
});

afterAll(async () => {
  const org = ids.org;
  await prisma.message.deleteMany({ where: { organizationId: org } });
  await prisma.conversation.deleteMany({ where: { organizationId: org } });
  await prisma.contact.deleteMany({ where: { organizationId: org } });
  await prisma.whatsAppChannel.deleteMany({ where: { organizationId: org } });
  await prisma.shop.deleteMany({ where: { organizationId: org } });
  await prisma.organization.delete({ where: { id: org } });
  await prisma.$disconnect();
});

afterEach(async () => {
  await prisma.message.deleteMany({ where: { conversationId: ids.conversation } });
  seq = 0;
});

describe('AiContextService — mémoire conversationnelle multi-tours', () => {
  it('inclut les tours précédents (client + IA/agent) dans l’ordre, note interne et média exclus', async () => {
    await addMessage('INBOUND', 'CUSTOMER', 'TEXT', 'Bonjour');
    await addMessage('OUTBOUND', 'AI', 'TEXT', 'Bonjour et bienvenue chez Boutique Awa !');
    await addMessage('INBOUND', 'CUSTOMER', 'TEXT', 'Vous avez des sacs rouges ?');
    await addMessage('OUTBOUND', 'AI', 'TEXT', 'Oui, le Sac Cabas à 15 000 XAF.');
    await addMessage('INTERNAL', 'AGENT', 'INTERNAL_NOTE', 'note interne — invisible pour l’IA');
    await addMessage('INBOUND', 'CUSTOMER', 'IMAGE', null); // média : exclu (textContent null)
    const anchorId = await addMessage('INBOUND', 'CUSTOMER', 'TEXT', 'Et en bleu ?');

    const ctx = await service.build({
      organizationId: ids.org,
      shopId: ids.shop,
      conversationId: ids.conversation,
      contextLastMessageId: anchorId,
      contextMaxMessages: 20,
    });

    expect(ctx).not.toBeNull();
    expect(ctx!.messages).toEqual([
      { role: 'CUSTOMER', content: 'Bonjour' },
      { role: 'AGENT', content: 'Bonjour et bienvenue chez Boutique Awa !' },
      { role: 'CUSTOMER', content: 'Vous avez des sacs rouges ?' },
      { role: 'AGENT', content: 'Oui, le Sac Cabas à 15 000 XAF.' },
      { role: 'CUSTOMER', content: 'Et en bleu ?' },
    ]);
    // Le prompt système nomme la boutique (accueil possible).
    expect(ctx!.systemPrompt).toContain('Boutique Awa');
  });

  it('borne le contexte aux N derniers messages (contextMaxMessages)', async () => {
    // 6 messages, mais fenêtre = 3 → seuls les 3 derniers sont gardés.
    await addMessage('INBOUND', 'CUSTOMER', 'TEXT', 'msg 1');
    await addMessage('OUTBOUND', 'AI', 'TEXT', 'msg 2');
    await addMessage('INBOUND', 'CUSTOMER', 'TEXT', 'msg 3');
    await addMessage('OUTBOUND', 'AI', 'TEXT', 'msg 4');
    await addMessage('INBOUND', 'CUSTOMER', 'TEXT', 'msg 5');
    const anchorId = await addMessage('INBOUND', 'CUSTOMER', 'TEXT', 'msg 6');

    const ctx = await service.build({
      organizationId: ids.org,
      shopId: ids.shop,
      conversationId: ids.conversation,
      contextLastMessageId: anchorId,
      contextMaxMessages: 3,
    });

    expect(ctx!.messages.map((m) => m.content)).toEqual(['msg 4', 'msg 5', 'msg 6']);
  });
});

// ------------------------------------------------------------------- CI-G1
describe('AiContextService — contexte enrichi et borné en tokens (CI-G1)', () => {
  it('injecte les RÈGLES de la boutique dans le prompt (systemPromptOverride n’est plus mort)', async () => {
    const anchorId = await addMessage('INBOUND', 'CUSTOMER', 'TEXT', 'Je peux rendre un article ?');

    const ctx = await service.build({
      organizationId: ids.org,
      shopId: ids.shop,
      conversationId: ids.conversation,
      contextLastMessageId: anchorId,
      contextMaxMessages: 20,
      businessRules: 'Aucun retour après 7 jours. Livraison Douala uniquement.',
      contextTokenBudget: 3000,
    });

    expect(ctx!.systemPrompt).toContain('Aucun retour après 7 jours.');
    expect(ctx!.budget.droppedBusinessRules).toBe(false);
  });

  it('injecte le résumé des HORAIRES (plus besoin d’un tour d’outil pour les réciter)', async () => {
    await prisma.shopOpeningHour.createMany({
      data: [
        { shopId: ids.shop, dayOfWeek: 'MONDAY', opensAtMinutes: 480, closesAtMinutes: 1080 },
        { shopId: ids.shop, dayOfWeek: 'SATURDAY', opensAtMinutes: 540, closesAtMinutes: 780 },
      ],
    });
    const anchorId = await addMessage('INBOUND', 'CUSTOMER', 'TEXT', 'Vous ouvrez à quelle heure ?');

    const ctx = await service.build({
      organizationId: ids.org,
      shopId: ids.shop,
      conversationId: ids.conversation,
      contextLastMessageId: anchorId,
      contextMaxMessages: 20,
      contextTokenBudget: 3000,
    });

    expect(ctx!.systemPrompt).toContain('lun 08:00-18:00');
    expect(ctx!.systemPrompt).toContain('sam 09:00-13:00');
    // Un jour sans plage est explicitement fermé (jamais deviné par le modèle).
    expect(ctx!.systemPrompt).toContain('dim fermé');

    await prisma.shopOpeningHour.deleteMany({ where: { shopId: ids.shop } });
  });

  it('aucun horaire configuré → aucune ligne Horaires (on ne prétend jamais « fermé »)', async () => {
    const anchorId = await addMessage('INBOUND', 'CUSTOMER', 'TEXT', 'Bonjour');

    const ctx = await service.build({
      organizationId: ids.org,
      shopId: ids.shop,
      conversationId: ids.conversation,
      contextLastMessageId: anchorId,
      contextMaxMessages: 20,
      contextTokenBudget: 3000,
    });

    expect(ctx!.systemPrompt).not.toContain('Horaires');
    expect(ctx!.systemPrompt).not.toContain('fermé');
  });

  it('budget serré : les messages les plus ANCIENS sautent, le déclencheur reste', async () => {
    const long = 'x'.repeat(400); // ≈ 101 tokens estimés chacun
    await addMessage('INBOUND', 'CUSTOMER', 'TEXT', `A ${long}`);
    await addMessage('OUTBOUND', 'AI', 'TEXT', `B ${long}`);
    const anchorId = await addMessage('INBOUND', 'CUSTOMER', 'TEXT', `C ${long}`);

    const ctx = await service.build({
      organizationId: ids.org,
      shopId: ids.shop,
      conversationId: ids.conversation,
      contextLastMessageId: anchorId,
      contextMaxMessages: 20,
      contextTokenBudget: 230,
    });

    expect(ctx!.messages).toHaveLength(2);
    expect(ctx!.messages[0].content.startsWith('B')).toBe(true);
    expect(ctx!.messages[1].content.startsWith('C')).toBe(true);
    // La coupe est RAPPORTÉE, jamais silencieuse.
    expect(ctx!.budget.droppedMessageCount).toBe(1);
    expect(ctx!.budget.estimatedTokens).toBeGreaterThan(0);
  });

  it('sans budget (0), le seul garde-fou reste contextMaxMessages', async () => {
    const long = 'x'.repeat(4000);
    await addMessage('INBOUND', 'CUSTOMER', 'TEXT', long);
    const anchorId = await addMessage('INBOUND', 'CUSTOMER', 'TEXT', long);

    const ctx = await service.build({
      organizationId: ids.org,
      shopId: ids.shop,
      conversationId: ids.conversation,
      contextLastMessageId: anchorId,
      contextMaxMessages: 20,
      contextTokenBudget: 0,
    });

    expect(ctx!.messages).toHaveLength(2);
    expect(ctx!.budget.droppedMessageCount).toBe(0);
  });
});
