import { readFileSync } from 'node:fs';

import { PrismaClient } from '@whauto/database';

import type { PrismaService } from '../../prisma/prisma.service';
import { AiToolExecutor } from './tool-executor';
import type { AiToolContext } from './tool-types';

/**
 * Tests d'INTÉGRATION des outils métier contre la vraie base (le scoping
 * tenant/Shop/Conversation ne se prouve qu'avec de vraies FK). Seed complet
 * sous une organisation dédiée, nettoyage en fin de suite.
 */

jest.setTimeout(60000);

function databaseUrl(): string {
  const envPath = 'C:/Users/Emma/Desktop/Whauto AI/.env';
  const raw = readFileSync(envPath, 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL introuvable');
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
const executor = new AiToolExecutor(prisma as unknown as PrismaService);
const TIMEOUT = 5000;

const ids: Record<string, string> = {};
let ctx: AiToolContext;
const SUFFIX = `aitool-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `AI Tools ${SUFFIX}`, slug: SUFFIX },
    select: { id: true },
  });
  ids.org = org.id;

  const shopA = await prisma.shop.create({
    data: {
      organizationId: org.id,
      name: 'Shop A',
      slug: `a-${SUFFIX}`,
      status: 'ACTIVE',
      countryCode: 'CM',
      timezone: 'Africa/Douala',
      currency: 'XAF',
      locale: 'fr',
    },
    select: { id: true },
  });
  ids.shopA = shopA.id;

  const shopB = await prisma.shop.create({
    data: {
      organizationId: org.id,
      name: 'Shop B',
      slug: `b-${SUFFIX}`,
      status: 'ACTIVE',
      countryCode: 'CM',
      timezone: 'Africa/Douala',
      currency: 'XAF',
      locale: 'fr',
    },
    select: { id: true },
  });
  ids.shopB = shopB.id;

  const category = await prisma.productCategory.create({
    data: { organizationId: org.id, shopId: shopA.id, name: 'Sacs', slug: `sacs-${SUFFIX}` },
    select: { id: true },
  });

  // Produit + variante de la Shop A, avec un COÛT à ne jamais divulguer.
  const productA = await prisma.product.create({
    data: {
      organizationId: org.id,
      shopId: shopA.id,
      categoryId: category.id,
      name: 'Sac Rouge',
      slug: `sac-rouge-${SUFFIX}`,
      shortDescription: 'Un beau sac rouge',
      currency: 'XAF',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  ids.productA = productA.id;
  const variantA = await prisma.productVariant.create({
    data: {
      organizationId: org.id,
      shopId: shopA.id,
      productId: productA.id,
      sku: `SKU-A-${SUFFIX}`.toUpperCase(),
      priceMinor: 15000,
      costPriceMinor: 8000, // NE DOIT JAMAIS apparaître dans un résultat d'outil.
      trackInventory: true,
      allowBackorder: false,
      isDefault: true,
      combinationKey: 'DEFAULT',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  ids.variantA = variantA.id;
  await prisma.inventoryItem.create({
    data: {
      organizationId: org.id,
      shopId: shopA.id,
      variantId: variantA.id,
      quantityOnHand: 10,
      quantityReserved: 0,
      lowStockThreshold: 5,
    },
  });

  // Produit + variante de la Shop B (pour les tests d'inaccessibilité).
  const productB = await prisma.product.create({
    data: {
      organizationId: org.id,
      shopId: shopB.id,
      name: 'Produit B',
      slug: `produit-b-${SUFFIX}`,
      currency: 'XAF',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  ids.productB = productB.id;
  const variantB = await prisma.productVariant.create({
    data: {
      organizationId: org.id,
      shopId: shopB.id,
      productId: productB.id,
      sku: `SKU-B-${SUFFIX}`.toUpperCase(),
      priceMinor: 5000,
      isDefault: true,
      combinationKey: 'DEFAULT',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  ids.variantB = variantB.id;

  await prisma.shopOpeningHour.create({
    data: { shopId: shopA.id, dayOfWeek: 'MONDAY', opensAtMinutes: 540, closesAtMinutes: 1080 },
  });

  const channel = await prisma.whatsAppChannel.create({
    data: {
      organizationId: org.id,
      shopId: shopA.id,
      provider: 'MOCK',
      status: 'CONNECTED',
      displayName: 'Canal A',
      phoneNumber: '+237600000000',
    },
    select: { id: true },
  });
  ids.channel = channel.id;

  const contactA = await prisma.contact.create({
    data: {
      organizationId: org.id,
      shopId: shopA.id,
      whatsappPhone: '+237600000001',
      normalizedPhone: '+237600000001',
    },
    select: { id: true },
  });
  ids.contactA = contactA.id;
  const contactOther = await prisma.contact.create({
    data: {
      organizationId: org.id,
      shopId: shopA.id,
      whatsappPhone: '+237600000002',
      normalizedPhone: '+237600000002',
    },
    select: { id: true },
  });
  ids.contactOther = contactOther.id;

  const conversation = await prisma.conversation.create({
    data: {
      organizationId: org.id,
      shopId: shopA.id,
      channelId: channel.id,
      contactId: contactA.id,
      status: 'OPEN',
    },
    select: { id: true },
  });
  ids.conversation = conversation.id;

  const message = await prisma.message.create({
    data: {
      organizationId: org.id,
      shopId: shopA.id,
      conversationId: conversation.id,
      channelId: channel.id,
      contactId: contactA.id,
      direction: 'INBOUND',
      type: 'TEXT',
      status: 'RECEIVED',
      senderType: 'CUSTOMER',
      textContent: 'bonjour',
    },
    select: { id: true },
  });

  // Commande du bon Contact/Conversation (chaîne Cart + CheckoutSession requise).
  const cart = await prisma.cart.create({
    data: {
      organizationId: org.id,
      shopId: shopA.id,
      contactId: contactA.id,
      conversationId: conversation.id,
      currency: 'XAF',
      status: 'CONVERTED',
    },
    select: { id: true },
  });
  const checkout = await prisma.checkoutSession.create({
    data: { organizationId: org.id, shopId: shopA.id, cartId: cart.id, customerPhone: '+237600000001' },
    select: { id: true },
  });
  await prisma.order.create({
    data: {
      organizationId: org.id,
      shopId: shopA.id,
      contactId: contactA.id,
      conversationId: conversation.id,
      cartId: cart.id,
      checkoutSessionId: checkout.id,
      orderNumber: `DEMO-${SUFFIX}`,
      fulfillmentType: 'PICKUP',
      currency: 'XAF',
      subtotalMinor: 15000,
      totalMinor: 15000,
      itemCount: 1,
      customerName: 'Client Démo',
      customerPhone: '+237600000001',
      paymentPreference: 'CASH_ON_DELIVERY',
      status: 'CONFIRMED',
      confirmedAt: new Date(),
    },
  });

  const run = await prisma.aiRun.create({
    data: {
      organizationId: org.id,
      shopId: shopA.id,
      conversationId: conversation.id,
      triggerMessageId: message.id,
      contextLastMessageId: message.id,
      provider: 'MOCK',
      model: 'mock-model',
      mode: 'SUGGEST_ONLY',
      status: 'RUNNING',
    },
    select: { id: true },
  });
  ids.aiRun = run.id;

  ctx = {
    organizationId: org.id,
    shopId: shopA.id,
    conversationId: conversation.id,
    contactId: contactA.id,
    aiRunId: run.id,
  };
});

afterAll(async () => {
  const org = ids.org;
  if (org) {
    await prisma.aiToolCall.deleteMany({ where: { organizationId: org } });
    await prisma.conversationHandoff.deleteMany({ where: { organizationId: org } });
    await prisma.aiRun.deleteMany({ where: { organizationId: org } });
    await prisma.order.deleteMany({ where: { organizationId: org } });
    await prisma.checkoutSession.deleteMany({ where: { organizationId: org } });
    await prisma.cart.deleteMany({ where: { organizationId: org } });
    await prisma.message.deleteMany({ where: { organizationId: org } });
    await prisma.conversation.deleteMany({ where: { organizationId: org } });
    await prisma.inventoryItem.deleteMany({ where: { organizationId: org } });
    await prisma.productVariant.deleteMany({ where: { organizationId: org } });
    await prisma.product.deleteMany({ where: { organizationId: org } });
    await prisma.productCategory.deleteMany({ where: { organizationId: org } });
    if (ids.shopA) await prisma.shopOpeningHour.deleteMany({ where: { shopId: ids.shopA } });
    await prisma.contact.deleteMany({ where: { organizationId: org } });
    await prisma.whatsAppChannel.deleteMany({ where: { organizationId: org } });
    await prisma.shop.deleteMany({ where: { organizationId: org } });
    await prisma.organization.delete({ where: { id: org } });
  }
  await prisma.$disconnect();
});

describe('search_products', () => {
  it('retourne les produits de la Shop, sans jamais costPriceMinor', async () => {
    const outcome = await executor.execute(ctx, 'search_products', { query: 'sac' }, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(outcome.status).toBe('SUCCEEDED');
    const products = (outcome.result as { products: Array<{ productId: string }> }).products;
    expect(products.map((p) => p.productId)).toContain(ids.productA);
    expect(JSON.stringify(outcome.result)).not.toMatch(/cost/i);
    expect(JSON.stringify(outcome.result)).not.toContain('8000');
  });

  it('refuse un paramètre inconnu (schéma strict)', async () => {
    const outcome = await executor.execute(ctx, 'search_products', { query: 'sac', evil: 1 }, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.errorCode).toBe('INVALID_ARGUMENTS');
  });

  it('refuse une limite hors borne', async () => {
    const outcome = await executor.execute(ctx, 'search_products', { query: 'sac', limit: 99 }, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(outcome.status).toBe('REJECTED');
  });
});

describe('get_product_details', () => {
  it('retourne les détails du produit de la Shop', async () => {
    const outcome = await executor.execute(ctx, 'get_product_details', { productId: ids.productA }, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(outcome.status).toBe('SUCCEEDED');
    expect(JSON.stringify(outcome.result)).not.toMatch(/cost/i);
  });

  it('produit d’une AUTRE Shop → introuvable (jamais divulgué)', async () => {
    const outcome = await executor.execute(ctx, 'get_product_details', { productId: ids.productB }, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorCode).toBe('PRODUCT_NOT_FOUND');
  });
});

describe('get_variant_availability', () => {
  it('retourne la disponibilité de la variante de la Shop', async () => {
    const outcome = await executor.execute(ctx, 'get_variant_availability', { variantId: ids.variantA }, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(outcome.status).toBe('SUCCEEDED');
    expect((outcome.result as { quantityAvailable: number }).quantityAvailable).toBe(10);
  });

  it('variante ÉTRANGÈRE (autre Shop) → introuvable', async () => {
    const outcome = await executor.execute(ctx, 'get_variant_availability', { variantId: ids.variantB }, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorCode).toBe('VARIANT_NOT_FOUND');
  });
});

describe('get_shop_opening_hours', () => {
  it('retourne les horaires et l’état d’ouverture', async () => {
    const outcome = await executor.execute(ctx, 'get_shop_opening_hours', {}, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(outcome.status).toBe('SUCCEEDED');
    expect((outcome.result as { hours: unknown[] }).hours.length).toBeGreaterThan(0);
  });
});

describe('get_order_status', () => {
  it('trouve la commande du client de la conversation', async () => {
    const outcome = await executor.execute(ctx, 'get_order_status', { orderNumber: `DEMO-${SUFFIX}` }, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(outcome.status).toBe('SUCCEEDED');
    expect(JSON.stringify(outcome.result)).not.toMatch(/address|adresse|customerName|Client Démo/i);
  });

  it('commande d’un AUTRE Contact → introuvable (anti-fuite)', async () => {
    const otherCtx = { ...ctx, contactId: ids.contactOther };
    const outcome = await executor.execute(otherCtx, 'get_order_status', { orderNumber: `DEMO-${SUFFIX}` }, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.errorCode).toBe('ORDER_NOT_FOUND');
  });
});

describe('request_human_handoff', () => {
  it('crée un handoff, puis est idempotent (jamais un second)', async () => {
    const first = await executor.execute(ctx, 'request_human_handoff', { reason: 'Réclamation' }, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(first.status).toBe('SUCCEEDED');
    expect((first.result as { alreadyOpen: boolean }).alreadyOpen).toBe(false);

    const second = await executor.execute(ctx, 'request_human_handoff', { reason: 'Encore' }, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(second.status).toBe('SUCCEEDED');
    expect((second.result as { alreadyOpen: boolean }).alreadyOpen).toBe(true);

    const count = await prisma.conversationHandoff.count({
      where: { conversationId: ids.conversation, status: { in: ['REQUESTED', 'ACCEPTED'] } },
    });
    expect(count).toBe(1);
  });
});

describe('exécuteur — garde-fous transverses', () => {
  it('outil inconnu → REJECTED, tracé', async () => {
    const outcome = await executor.execute(ctx, 'drop_table', { x: 1 }, { round: 0, sequence: 0, timeoutMs: TIMEOUT });
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.errorCode).toBe('UNKNOWN_TOOL');
  });

  it('persiste AiToolCall avec arguments/résumé filtrés uniquement', async () => {
    await executor.execute(ctx, 'get_variant_availability', { variantId: ids.variantA }, { round: 1, sequence: 1, timeoutMs: TIMEOUT });
    const call = await prisma.aiToolCall.findFirst({
      where: { aiRunId: ids.aiRun, toolName: 'get_variant_availability', round: 1 },
      select: { argumentsFiltered: true, resultSummaryFiltered: true, status: true },
    });
    expect(call?.status).toBe('SUCCEEDED');
    expect(call?.argumentsFiltered).toBeDefined();
    // Le résumé ne contient JAMAIS le coût.
    expect(JSON.stringify(call?.resultSummaryFiltered)).not.toMatch(/cost/i);
  });

  it('aucune écriture commerciale : le stock reste inchangé après les lectures', async () => {
    const inventory = await prisma.inventoryItem.findFirst({
      where: { variantId: ids.variantA },
      select: { quantityOnHand: true },
    });
    expect(inventory?.quantityOnHand).toBe(10);
  });
});
