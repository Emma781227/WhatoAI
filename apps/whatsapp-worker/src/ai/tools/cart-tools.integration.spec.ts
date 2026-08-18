import { readFileSync } from 'node:fs';

import { PrismaClient } from '@whauto/database';
import { SOCKET_EVENTS } from '@whauto/shared';

import type { PrismaService } from '../../prisma/prisma.service';
import { AI_CART_TOOL_NAMES } from './cart-tools';
import { AiToolExecutor } from './tool-executor';
import { AI_TOOL_REGISTRY, aiToolDefinitions } from './tool-registry';
import type { AiToolContext } from './tool-types';

/**
 * Tests d'INTÉGRATION des outils WRITE panier (AI-C / W1) contre la vraie base :
 * la mutation, l'idempotence (clientMutationId) et le scoping tenant ne se
 * prouvent qu'avec de vraies FK + index. Seed dédié, nettoyage en fin de suite.
 */

jest.setTimeout(60000);

function databaseUrl(): string {
  const raw = readFileSync('C:/Users/Emma/Desktop/Whauto AI/.env', 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL introuvable');
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
const executor = new AiToolExecutor(prisma as unknown as PrismaService);
const SUFFIX = `aicart-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ids: Record<string, string> = {};
let ctx: AiToolContext;
let seq = 0;

function runTool(name: string, input: unknown) {
  seq += 1;
  return AI_TOOL_REGISTRY[name].run(prisma as unknown as PrismaService, ctx, input as never, {
    round: 1,
    sequence: seq,
  });
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `AI Cart ${SUFFIX}`, slug: SUFFIX },
    select: { id: true },
  });
  ids.org = org.id;
  const shop = await prisma.shop.create({
    data: {
      organizationId: org.id,
      name: 'Shop',
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
  const otherShop = await prisma.shop.create({
    data: {
      organizationId: org.id,
      name: 'Other',
      slug: `o-${SUFFIX}`,
      status: 'ACTIVE',
      countryCode: 'CM',
      timezone: 'Africa/Douala',
      currency: 'XAF',
      locale: 'fr',
    },
    select: { id: true },
  });
  const product = await prisma.product.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      name: 'Sac Cabas',
      slug: `sac-${SUFFIX}`,
      currency: 'XAF',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  const variant = await prisma.productVariant.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      productId: product.id,
      name: 'Rouge',
      sku: `SKU-${SUFFIX}`.toUpperCase(),
      priceMinor: 9000,
      costPriceMinor: 4000, // NE DOIT JAMAIS fuiter dans un résultat d'outil.
      trackInventory: true,
      allowBackorder: false,
      isDefault: true,
      combinationKey: 'DEFAULT',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  ids.variant = variant.id;
  await prisma.inventoryItem.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      variantId: variant.id,
      quantityOnHand: 20,
      quantityReserved: 0,
      lowStockThreshold: 5,
    },
  });
  // Variante d'une AUTRE Shop (inaccessible depuis cette conversation).
  const otherProduct = await prisma.product.create({
    data: { organizationId: org.id, shopId: otherShop.id, name: 'X', slug: `x-${SUFFIX}`, currency: 'XAF', status: 'ACTIVE' },
    select: { id: true },
  });
  const otherVariant = await prisma.productVariant.create({
    data: {
      organizationId: org.id,
      shopId: otherShop.id,
      productId: otherProduct.id,
      sku: `SKUX-${SUFFIX}`.toUpperCase(),
      priceMinor: 5000,
      isDefault: true,
      combinationKey: 'DEFAULT',
      status: 'ACTIVE',
    },
    select: { id: true },
  });
  ids.otherVariant = otherVariant.id;

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
  const contact = await prisma.contact.create({
    data: { organizationId: org.id, shopId: shop.id, whatsappPhone: '+237600000001', normalizedPhone: '+237600000001' },
    select: { id: true },
  });
  const conversation = await prisma.conversation.create({
    data: { organizationId: org.id, shopId: shop.id, channelId: channel.id, contactId: contact.id, status: 'OPEN' },
    select: { id: true },
  });
  const message = await prisma.message.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      conversationId: conversation.id,
      channelId: channel.id,
      contactId: contact.id,
      direction: 'INBOUND',
      type: 'TEXT',
      status: 'RECEIVED',
      senderType: 'CUSTOMER',
      textContent: 'bonjour',
    },
    select: { id: true },
  });
  const run = await prisma.aiRun.create({
    data: {
      organizationId: org.id,
      shopId: shop.id,
      conversationId: conversation.id,
      triggerMessageId: message.id,
      contextLastMessageId: message.id,
      provider: 'MOCK',
      model: 'mock-model',
      mode: 'AUTO_REPLY',
      status: 'RUNNING',
    },
    select: { id: true },
  });
  ids.conversation = conversation.id;
  ctx = {
    organizationId: org.id,
    shopId: shop.id,
    conversationId: conversation.id,
    contactId: contact.id,
    aiRunId: run.id,
  };
});

afterAll(async () => {
  const org = ids.org;
  if (org) {
    await prisma.cartMutation.deleteMany({ where: { organizationId: org } });
    await prisma.cartItem.deleteMany({ where: { organizationId: org } });
    await prisma.cart.deleteMany({ where: { organizationId: org } });
    await prisma.aiToolCall.deleteMany({ where: { organizationId: org } });
    await prisma.aiRun.deleteMany({ where: { organizationId: org } });
    await prisma.message.deleteMany({ where: { organizationId: org } });
    await prisma.conversation.deleteMany({ where: { organizationId: org } });
    await prisma.contact.deleteMany({ where: { organizationId: org } });
    await prisma.whatsAppChannel.deleteMany({ where: { organizationId: org } });
    await prisma.inventoryItem.deleteMany({ where: { organizationId: org } });
    await prisma.productVariant.deleteMany({ where: { organizationId: org } });
    await prisma.product.deleteMany({ where: { organizationId: org } });
    await prisma.shop.deleteMany({ where: { organizationId: org } });
    await prisma.organization.delete({ where: { id: org } });
  }
  await prisma.$disconnect();
});

describe('Outils WRITE panier (intégration)', () => {
  it('add_to_cart crée le panier, ajoute la ligne, ne divulgue JAMAIS le coût (via executor)', async () => {
    const out = await executor.execute(
      ctx,
      'add_to_cart',
      { variantId: ids.variant, quantity: 2 },
      { round: 1, sequence: 100, timeoutMs: 5000 },
    );
    expect(out.status).toBe('SUCCEEDED');
    const result = out.result as { items: Array<{ variantId: string; quantity: number }>; itemCount: number };
    expect(result.itemCount).toBe(2);
    expect(result.items[0].variantId).toBe(ids.variant);
    // Aucune fuite du coût.
    expect(JSON.stringify(out.result)).not.toContain('4000');
    // Temps réel : l'outil déclare cart.updated (émis par l'orchestrateur après commit).
    expect(out.realtimeEvents.map((e) => e.event)).toContain(SOCKET_EVENTS.CART_UPDATED);

    const dbItem = await prisma.cartItem.findFirst({
      where: { variantId: ids.variant },
      select: { quantity: true },
    });
    expect(dbItem?.quantity).toBe(2);
  });

  it('add_to_cart de la même variante incrémente la quantité (mutation distincte)', async () => {
    const r = (await runTool('add_to_cart', { variantId: ids.variant, quantity: 1 })).result as {
      itemCount: number;
    };
    expect(r.itemCount).toBe(3);
  });

  it('get_cart reflète le panier courant', async () => {
    const r = (await runTool('get_cart', {})).result as { items: unknown[]; itemCount: number };
    expect(r.itemCount).toBe(3);
    expect(r.items).toHaveLength(1);
  });

  it('update_cart_quantity fixe la quantité', async () => {
    const cartItem = await prisma.cartItem.findFirstOrThrow({ where: { variantId: ids.variant }, select: { id: true } });
    const r = (await runTool('update_cart_quantity', { cartItemId: cartItem.id, quantity: 5 })).result as {
      itemCount: number;
    };
    expect(r.itemCount).toBe(5);
  });

  it('idempotence : même clientMutationId (même round+sequence) → un seul effet', async () => {
    const meta = { round: 9, sequence: 9 };
    const before = (
      (await AI_TOOL_REGISTRY.add_to_cart.run(prisma as unknown as PrismaService, ctx, { variantId: ids.variant, quantity: 1 } as never, meta)).result as { itemCount: number }
    ).itemCount;
    // Rejeu EXACT (même meta → même clientMutationId) : aucun double effet.
    const after = (
      (await AI_TOOL_REGISTRY.add_to_cart.run(prisma as unknown as PrismaService, ctx, { variantId: ids.variant, quantity: 1 } as never, meta)).result as { itemCount: number }
    ).itemCount;
    expect(after).toBe(before);
  });

  it('remove_from_cart retire la ligne', async () => {
    const cartItem = await prisma.cartItem.findFirstOrThrow({ where: { variantId: ids.variant }, select: { id: true } });
    const r = (await runTool('remove_from_cart', { cartItemId: cartItem.id })).result as { itemCount: number };
    expect(r.itemCount).toBe(0);
  });

  it('variante d’une autre Shop → refusée (VARIANT_NOT_FOUND), aucune écriture', async () => {
    await expect(runTool('add_to_cart', { variantId: ids.otherVariant, quantity: 1 })).rejects.toMatchObject({
      code: 'VARIANT_NOT_FOUND',
    });
  });

  // ------------------------------------------------------------------- W3
  it('marquage : la ligne créée par l’IA porte source=AI et le run exact', async () => {
    await runTool('add_to_cart', { variantId: ids.variant, quantity: 1 });
    const line = await prisma.cartItem.findFirstOrThrow({
      where: { variantId: ids.variant },
      select: { addedBySource: true, addedByAiRunId: true },
    });
    expect(line.addedBySource).toBe('AI');
    expect(line.addedByAiRunId).toBe(ctx.aiRunId);
  });

  it('marquage : un incrément de l’IA ne réécrit PAS une ligne créée par un humain', async () => {
    // Ligne posée « à la main » (comme le ferait l'API depuis l'inbox).
    const cart = await prisma.cart.findFirstOrThrow({
      where: { conversationId: ids.conversation, status: 'ACTIVE' },
      select: { id: true, shopId: true, organizationId: true },
    });
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    const human = await prisma.cartItem.create({
      data: {
        organizationId: cart.organizationId,
        shopId: cart.shopId,
        cartId: cart.id,
        productId: (await prisma.productVariant.findFirstOrThrow({ where: { id: ids.variant }, select: { productId: true } })).productId,
        variantId: ids.variant,
        quantity: 1,
        unitPriceMinor: 9000,
        lineSubtotalMinor: 9000,
        productNameSnapshot: 'Sac Cabas',
        skuSnapshot: `SKU-${SUFFIX}`.toUpperCase(),
      },
      select: { id: true },
    });

    await runTool('add_to_cart', { variantId: ids.variant, quantity: 1 });

    const after = await prisma.cartItem.findUniqueOrThrow({
      where: { id: human.id },
      select: { quantity: true, addedBySource: true, addedByAiRunId: true },
    });
    expect(after.quantity).toBe(2); // l'IA a bien incrémenté…
    expect(after.addedBySource).toBe('HUMAN'); // …sans s'attribuer la ligne.
    expect(after.addedByAiRunId).toBeNull();
  });

  it('verrou d’activation : cartToolsEnabled=false → REJECTED (TOOL_DISABLED), aucune mutation', async () => {
    const before = await prisma.cartItem.count({ where: { organizationId: ids.org } });
    const out = await executor.execute(
      ctx,
      'add_to_cart',
      { variantId: ids.variant, quantity: 3 },
      { round: 2, sequence: 200, timeoutMs: 5000, cartToolsEnabled: false },
    );
    expect(out.status).toBe('REJECTED');
    expect(out.errorCode).toBe('TOOL_DISABLED');
    expect(out.realtimeEvents).toHaveLength(0);
    expect(await prisma.cartItem.count({ where: { organizationId: ids.org } })).toBe(before);
    // Le refus est tracé comme tout autre appel d'outil.
    const call = await prisma.aiToolCall.findFirstOrThrow({ where: { id: out.aiToolCallId } });
    expect(call.status).toBe('REJECTED');
    expect(call.errorCode).toBe('TOOL_DISABLED');
  });

  it('verrou d’exposition : les outils panier disparaissent des définitions transmises au modèle', () => {
    const withCart = aiToolDefinitions({ cartToolsEnabled: true }).map((t) => t.name);
    const without = aiToolDefinitions({ cartToolsEnabled: false }).map((t) => t.name);
    expect(withCart).toEqual(expect.arrayContaining([...AI_CART_TOOL_NAMES]));
    for (const name of AI_CART_TOOL_NAMES) {
      expect(without).not.toContain(name);
    }
    // Les outils LECTURE ne bougent jamais.
    expect(without).toEqual(expect.arrayContaining(['search_products', 'request_human_handoff']));
    expect(without).toHaveLength(withCart.length - AI_CART_TOOL_NAMES.size);
  });
});
