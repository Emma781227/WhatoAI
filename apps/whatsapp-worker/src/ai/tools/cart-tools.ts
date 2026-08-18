import {
  addItemToCartTx,
  isDuplicateCartMutation,
  removeCartItemTx,
  updateCartItemQuantityTx,
  type CartMutationDeps,
  type CartVariantForAdd,
} from '@whauto/commerce';
import { Prisma } from '@whauto/database';
import { SOCKET_EVENTS, type CartRealtimeEvent } from '@whauto/shared';
import { z } from 'zod';

import type { PrismaService } from '../../prisma/prisma.service';
import {
  AiToolError,
  type AiToolContext,
  type AiToolCallMeta,
  type AiToolDefinitionEntry,
  type AiToolRealtimeEvent,
  type AiToolRunResult,
} from './tool-types';

interface AiCartView {
  cartId: string;
  status: string;
  currency: string;
  cartVersion: number;
  itemCount: number;
  subtotalMinor: number;
  totalMinor: number;
  items: Array<{
    cartItemId: string;
    variantId: string;
    productName: string;
    variantName: string | null;
    quantity: number;
    unitPriceMinor: number;
    lineSubtotalMinor: number;
  }>;
}

/** Événement `cart.updated` (même contrat que l'API) — panneau Panier en direct. */
function cartUpdatedEvent(ctx: AiToolContext, view: AiCartView): AiToolRealtimeEvent[] {
  const payload: CartRealtimeEvent = {
    organizationId: ctx.organizationId,
    shopId: ctx.shopId,
    conversationId: ctx.conversationId,
    cartId: view.cartId,
    cartVersion: view.cartVersion,
  };
  return [{ event: SOCKET_EVENTS.CART_UPDATED, payload }];
}

/**
 * Outils WRITE panier (AI-C / W1) : l'IA construit le panier conversationnellement.
 * Ils appellent le CŒUR partagé `@whauto/commerce` DANS leur propre transaction —
 * mêmes garde-fous que l'API (verrous, idempotence, versions, totaux), zéro
 * duplication. Périmètre volontairement RÉVERSIBLE : uniquement le panier ACTIVE
 * (un panier en checkout est refusé — c'est un flux humain). Aucun engagement de
 * stock (les réservations n'ont lieu qu'au checkout). Résultats filtrés/bornés.
 */

const OPEN_STATUSES = ['ACTIVE', 'CHECKOUT_STARTED'] as const;

/** TTL d'inactivité du panier (aligné sur la config API, défaut 120). */
function cartTtlMinutes(): number {
  const raw = Number(process.env.CART_INACTIVITY_TTL_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 120;
}

/** Clé d'idempotence stable pour un rejeu DANS le run (dédup via CartMutation). */
function aiClientMutationId(ctx: AiToolContext, meta: AiToolCallMeta): string {
  return `ai.${ctx.aiRunId}.${meta.round}.${meta.sequence}`;
}

/**
 * Deps de mutation côté IA : les réservations ne doivent JAMAIS être atteintes
 * (on refuse les paniers en checkout AVANT le cœur) — elles lèvent par défense.
 * L'audit est tracé via AiToolCall, d'où le no-op.
 */
const AI_CART_DEPS: CartMutationDeps = {
  reserveForItem: () => {
    throw new AiToolError('Panier en cours de validation — modification impossible.', 'CART_IN_CHECKOUT');
  },
  adjustActiveReservation: () => {
    throw new AiToolError('Panier en cours de validation — modification impossible.', 'CART_IN_CHECKOUT');
  },
  releaseReservation: () => {
    throw new AiToolError('Panier en cours de validation — modification impossible.', 'CART_IN_CHECKOUT');
  },
  recordAudit: async () => {
    // Tracé par AiToolCall (le worker n'écrit pas d'audit métier depuis un outil).
  },
};

async function readShopScope(
  prisma: PrismaService,
  ctx: AiToolContext,
): Promise<{ currency: string; archived: boolean }> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: ctx.conversationId, organizationId: ctx.organizationId },
    select: { shop: { select: { status: true, currency: true } } },
  });
  if (!conversation) {
    throw new AiToolError('Conversation introuvable.', 'CONVERSATION_NOT_FOUND');
  }
  return { currency: conversation.shop.currency, archived: conversation.shop.status === 'ARCHIVED' };
}

async function findOpenCart(
  prisma: PrismaService,
  ctx: AiToolContext,
): Promise<{ id: string; status: string } | null> {
  return prisma.cart.findFirst({
    where: {
      conversationId: ctx.conversationId,
      organizationId: ctx.organizationId,
      status: { in: [...OPEN_STATUSES] },
    },
    select: { id: true, status: true },
  });
}

/** Lecture FILTRÉE du panier pour le modèle — jamais de coût/adresse/snapshot interne. */
async function readFilteredCart(prisma: PrismaService, cartId: string): Promise<AiCartView> {
  const cart = await prisma.cart.findUniqueOrThrow({
    where: { id: cartId },
    select: {
      id: true,
      status: true,
      currency: true,
      version: true,
      itemCount: true,
      subtotalMinor: true,
      totalMinor: true,
      items: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          variantId: true,
          quantity: true,
          unitPriceMinor: true,
          lineSubtotalMinor: true,
          productNameSnapshot: true,
          variantNameSnapshot: true,
        },
      },
    },
  });
  return {
    cartId: cart.id,
    status: cart.status,
    currency: cart.currency,
    cartVersion: cart.version,
    itemCount: cart.itemCount,
    subtotalMinor: cart.subtotalMinor,
    totalMinor: cart.totalMinor,
    items: cart.items.map((item) => ({
      cartItemId: item.id,
      variantId: item.variantId,
      productName: item.productNameSnapshot,
      variantName: item.variantNameSnapshot,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      lineSubtotalMinor: item.lineSubtotalMinor,
    })),
  };
}

/** Charge la variante FRAÎCHE + valide statut/devise avant mutation. */
async function loadValidVariant(
  prisma: PrismaService,
  ctx: AiToolContext,
  variantId: string,
  expectedCurrency: string,
): Promise<CartVariantForAdd> {
  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, organizationId: ctx.organizationId, shopId: ctx.shopId },
    select: {
      id: true,
      status: true,
      name: true,
      sku: true,
      priceMinor: true,
      compareAtPriceMinor: true,
      trackInventory: true,
      allowBackorder: true,
      productId: true,
      product: {
        select: {
          status: true,
          name: true,
          currency: true,
          images: { where: { isPrimary: true }, select: { url: true }, take: 1 },
        },
      },
      optionValues: {
        select: {
          option: { select: { name: true, position: true } },
          optionValue: { select: { value: true } },
        },
      },
      inventory: { select: { quantityOnHand: true, quantityReserved: true } },
    },
  });
  if (!variant) {
    throw new AiToolError('Variante introuvable ou indisponible.', 'VARIANT_NOT_FOUND');
  }
  if (variant.status !== 'ACTIVE' || variant.product.status !== 'ACTIVE') {
    throw new AiToolError('Produit indisponible.', 'PRODUCT_UNAVAILABLE');
  }
  if (variant.product.currency !== expectedCurrency) {
    throw new AiToolError('Devise incohérente.', 'CURRENCY_MISMATCH');
  }
  return {
    id: variant.id,
    productId: variant.productId,
    priceMinor: variant.priceMinor,
    compareAtPriceMinor: variant.compareAtPriceMinor,
    trackInventory: variant.trackInventory,
    allowBackorder: variant.allowBackorder,
    name: variant.name,
    sku: variant.sku,
    product: { name: variant.product.name, images: variant.product.images },
    optionValues: variant.optionValues,
    inventory: variant.inventory,
  };
}

/** Panier ACTIVE requis pour muter — un panier en checkout est refusé (flux humain). */
async function requireActiveCart(
  prisma: PrismaService,
  ctx: AiToolContext,
): Promise<{ id: string }> {
  const cart = await findOpenCart(prisma, ctx);
  if (!cart) {
    throw new AiToolError('Aucun panier ouvert.', 'CART_NOT_FOUND');
  }
  if (cart.status !== 'ACTIVE') {
    throw new AiToolError('Panier en cours de validation — modification impossible.', 'CART_IN_CHECKOUT');
  }
  return { id: cart.id };
}

// --- add_to_cart -------------------------------------------------------------
const addToCartInput = z
  .object({ variantId: z.string().trim().min(1).max(64), quantity: z.number().int().min(1).max(999) })
  .strict();

const addToCart: AiToolDefinitionEntry<z.infer<typeof addToCartInput>> = {
  name: 'add_to_cart',
  description:
    'Ajoute une variante au panier du client (crée le panier au besoin). Renvoie le panier à jour.',
  parameters: {
    type: 'object',
    properties: {
      variantId: { type: 'string', description: 'Identifiant de la variante à ajouter.' },
      quantity: { type: 'integer', description: 'Quantité (1-999).' },
    },
    required: ['variantId', 'quantity'],
  },
  inputSchema: addToCartInput,
  async run(prisma, ctx, input, meta): Promise<AiToolRunResult> {
    const scope = await readShopScope(prisma, ctx);
    if (scope.archived) {
      throw new AiToolError('Boutique archivée.', 'SHOP_ARCHIVED');
    }
    const variant = await loadValidVariant(prisma, ctx, input.variantId, scope.currency);

    const existing = await findOpenCart(prisma, ctx);
    if (existing && existing.status !== 'ACTIVE') {
      throw new AiToolError('Panier en cours de validation — modification impossible.', 'CART_IN_CHECKOUT');
    }
    const cartId = existing ? existing.id : await createActiveCart(prisma, ctx, scope.currency);

    try {
      await prisma.$transaction((tx) =>
        addItemToCartTx(
          tx,
          {
            organizationId: ctx.organizationId,
            shopId: ctx.shopId,
            conversationId: ctx.conversationId,
            cartId,
            inactivityTtlMinutes: cartTtlMinutes(),
            variant,
            quantity: input.quantity,
            clientMutationId: aiClientMutationId(ctx, meta),
            // Marquage W3 : la ligne créée porte son origine + le run exact.
            // Un incrément sur une ligne humaine existante ne la réécrit pas.
            origin: { source: 'AI', aiRunId: ctx.aiRunId },
          },
          AI_CART_DEPS,
        ),
      );
    } catch (error) {
      // Rejeu idempotent (même clientMutationId) : aucun double effet.
      if (!isDuplicateCartMutation(error)) {
        throw error;
      }
    }

    const view = await readFilteredCart(prisma, cartId);
    return {
      result: view,
      summary: { cartId, itemCount: view.itemCount, addedVariantId: input.variantId },
      realtimeEvents: cartUpdatedEvent(ctx, view),
    };
  },
};

// --- get_cart ----------------------------------------------------------------
const getCartInput = z.object({}).strict();

const getCart: AiToolDefinitionEntry<z.infer<typeof getCartInput>> = {
  name: 'get_cart',
  description: 'Contenu actuel du panier du client (articles, quantités, totaux).',
  parameters: { type: 'object', properties: {} },
  inputSchema: getCartInput,
  async run(prisma, ctx): Promise<AiToolRunResult> {
    const cart = await findOpenCart(prisma, ctx);
    if (!cart) {
      return { result: { empty: true, items: [] }, summary: { empty: true } };
    }
    const view = await readFilteredCart(prisma, cart.id);
    return {
      result: view,
      summary: { cartId: cart.id, itemCount: view.itemCount },
      realtimeEvents: cartUpdatedEvent(ctx, view),
    };
  },
};

// --- update_cart_quantity ----------------------------------------------------
const updateQuantityInput = z
  .object({ cartItemId: z.string().trim().min(1).max(64), quantity: z.number().int().min(1).max(999) })
  .strict();

const updateCartQuantity: AiToolDefinitionEntry<z.infer<typeof updateQuantityInput>> = {
  name: 'update_cart_quantity',
  description: 'Change la quantité d’une ligne existante du panier. Renvoie le panier à jour.',
  parameters: {
    type: 'object',
    properties: {
      cartItemId: { type: 'string', description: 'Identifiant de la ligne de panier.' },
      quantity: { type: 'integer', description: 'Nouvelle quantité (1-999).' },
    },
    required: ['cartItemId', 'quantity'],
  },
  inputSchema: updateQuantityInput,
  async run(prisma, ctx, input, meta): Promise<AiToolRunResult> {
    const cart = await requireActiveCart(prisma, ctx);
    try {
      await prisma.$transaction((tx) =>
        updateCartItemQuantityTx(
          tx,
          {
            organizationId: ctx.organizationId,
            shopId: ctx.shopId,
            conversationId: ctx.conversationId,
            cartId: cart.id,
            inactivityTtlMinutes: cartTtlMinutes(),
            cartItemId: input.cartItemId,
            quantity: input.quantity,
            clientMutationId: aiClientMutationId(ctx, meta),
          },
          AI_CART_DEPS,
        ),
      );
    } catch (error) {
      if (!isDuplicateCartMutation(error)) {
        throw error;
      }
    }
    const view = await readFilteredCart(prisma, cart.id);
    return {
      result: view,
      summary: { cartId: cart.id, itemCount: view.itemCount },
      realtimeEvents: cartUpdatedEvent(ctx, view),
    };
  },
};

// --- remove_from_cart --------------------------------------------------------
const removeInput = z.object({ cartItemId: z.string().trim().min(1).max(64) }).strict();

const removeFromCart: AiToolDefinitionEntry<z.infer<typeof removeInput>> = {
  name: 'remove_from_cart',
  description: 'Retire une ligne du panier. Renvoie le panier à jour.',
  parameters: {
    type: 'object',
    properties: { cartItemId: { type: 'string', description: 'Identifiant de la ligne à retirer.' } },
    required: ['cartItemId'],
  },
  inputSchema: removeInput,
  async run(prisma, ctx, input): Promise<AiToolRunResult> {
    const cart = await requireActiveCart(prisma, ctx);
    await prisma.$transaction((tx) =>
      removeCartItemTx(
        tx,
        {
          organizationId: ctx.organizationId,
          shopId: ctx.shopId,
          conversationId: ctx.conversationId,
          cartId: cart.id,
          inactivityTtlMinutes: cartTtlMinutes(),
          cartItemId: input.cartItemId,
        },
        AI_CART_DEPS,
      ),
    );
    const view = await readFilteredCart(prisma, cart.id);
    return {
      result: view,
      summary: { cartId: cart.id, itemCount: view.itemCount },
      realtimeEvents: cartUpdatedEvent(ctx, view),
    };
  },
};

/** Crée un panier ACTIVE ; en cas de course (index partiel) réutilise l'existant. */
async function createActiveCart(
  prisma: PrismaService,
  ctx: AiToolContext,
  currency: string,
): Promise<string> {
  try {
    const cart = await prisma.cart.create({
      data: {
        organizationId: ctx.organizationId,
        shopId: ctx.shopId,
        contactId: ctx.contactId,
        conversationId: ctx.conversationId,
        currency,
        expiresAt: new Date(Date.now() + cartTtlMinutes() * 60_000),
      },
      select: { id: true },
    });
    return cart.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await findOpenCart(prisma, ctx);
      if (existing) {
        return existing.id;
      }
    }
    throw error;
  }
}


/**
 * Outils WRITE panier — enregistrés dans le registre principal, mais retirés
 * des définitions transmises au modèle ET refusés à l'exécution quand
 * `AiConfiguration.cartToolsEnabled` est false (W3 : deux verrous distincts,
 * jamais le prompt seul).
 */
export const AI_CART_WRITE_TOOLS: Record<string, AiToolDefinitionEntry> = {
  [addToCart.name]: addToCart as AiToolDefinitionEntry,
  [getCart.name]: getCart as AiToolDefinitionEntry,
  [updateCartQuantity.name]: updateCartQuantity as AiToolDefinitionEntry,
  [removeFromCart.name]: removeFromCart as AiToolDefinitionEntry,
};

/** Noms des outils panier — base des deux verrous (exposition + exécution). */
export const AI_CART_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(AI_CART_WRITE_TOOLS));
