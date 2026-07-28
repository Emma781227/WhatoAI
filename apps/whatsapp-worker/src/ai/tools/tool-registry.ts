import { computeQuantityAvailable, computeVariantStockStatus } from '@whauto/shared';
import { z } from 'zod';

import { computeOpenState, minutesToHhmm, type OpeningRange } from './opening-hours';
import { AiToolError, type AiToolDefinitionEntry, type AiToolRunResult } from './tool-types';

/**
 * Registre EXPLICITE des six outils métier en lecture seule (sous-phase B).
 * Chaque outil : schéma Zod STRICT (aucun paramètre inconnu), scoping tenant
 * OBLIGATOIRE, résultats filtrés/bornés. costPriceMinor, adresses complètes et
 * notes internes ne sont JAMAIS sélectionnés ni retournés.
 */

const LIMIT = z.number().int().min(1).max(10);

// --- 1. search_products ------------------------------------------------------
const searchProductsInput = z
  .object({
    query: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(80).optional(),
    maxPriceMinor: z.number().int().positive().max(2_147_483_647).optional(),
    limit: LIMIT.default(5),
  })
  .strict();

const searchProducts: AiToolDefinitionEntry<z.infer<typeof searchProductsInput>> = {
  name: 'search_products',
  description:
    'Recherche les produits actifs de la boutique par mots-clés. Retourne des résultats bornés avec prix et disponibilité.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Mots-clés de recherche.' },
      category: { type: 'string', description: 'Nom de catégorie (optionnel).' },
      maxPriceMinor: { type: 'integer', description: 'Prix maximum en plus petite unité (optionnel).' },
      limit: { type: 'integer', description: 'Nombre maximum de résultats (1-10).' },
    },
    required: ['query'],
  },
  inputSchema: searchProductsInput,
  async run(prisma, ctx, input): Promise<AiToolRunResult> {
    let categoryId: string | undefined;
    if (input.category) {
      const category = await prisma.productCategory.findFirst({
        where: {
          organizationId: ctx.organizationId,
          shopId: ctx.shopId,
          name: { equals: input.category, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (!category) {
        return { result: { products: [] }, summary: { count: 0, categoryUnknown: true } };
      }
      categoryId = category.id;
    }

    const products = await prisma.product.findMany({
      where: {
        organizationId: ctx.organizationId,
        shopId: ctx.shopId,
        status: 'ACTIVE',
        ...(categoryId ? { categoryId } : {}),
        OR: [
          { name: { contains: input.query, mode: 'insensitive' } },
          { shortDescription: { contains: input.query, mode: 'insensitive' } },
        ],
        ...(input.maxPriceMinor !== undefined
          ? { variants: { some: { status: 'ACTIVE', priceMinor: { lte: input.maxPriceMinor } } } }
          : {}),
      },
      take: input.limit,
      orderBy: [{ featured: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        name: true,
        shortDescription: true,
        currency: true,
        category: { select: { name: true } },
        // costPriceMinor JAMAIS sélectionné.
        variants: {
          where: { status: 'ACTIVE', archivedAt: null },
          select: {
            id: true,
            name: true,
            priceMinor: true,
            trackInventory: true,
            allowBackorder: true,
            inventory: { select: { quantityOnHand: true, quantityReserved: true, lowStockThreshold: true } },
          },
        },
        images: { where: { isPrimary: true }, select: { url: true }, take: 1 },
      },
    });

    const results = products
      .map((product) => summariseProduct(product))
      .filter((entry) => entry.variants.length > 0);

    return {
      result: { products: results },
      summary: { count: results.length, productIds: results.map((entry) => entry.productId) },
    };
  },
};

// --- 2. get_product_details --------------------------------------------------
const getProductDetailsInput = z.object({ productId: z.string().trim().min(1).max(64) }).strict();

const getProductDetails: AiToolDefinitionEntry<z.infer<typeof getProductDetailsInput>> = {
  name: 'get_product_details',
  description: 'Détails d’un produit actif : variantes, options, prix et disponibilité.',
  parameters: {
    type: 'object',
    properties: { productId: { type: 'string' } },
    required: ['productId'],
  },
  inputSchema: getProductDetailsInput,
  async run(prisma, ctx, input): Promise<AiToolRunResult> {
    const product = await prisma.product.findFirst({
      where: {
        id: input.productId,
        organizationId: ctx.organizationId,
        shopId: ctx.shopId,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        name: true,
        description: true,
        shortDescription: true,
        currency: true,
        category: { select: { name: true } },
        variants: {
          where: { status: 'ACTIVE', archivedAt: null },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            priceMinor: true,
            compareAtPriceMinor: true,
            trackInventory: true,
            allowBackorder: true,
            inventory: { select: { quantityOnHand: true, quantityReserved: true, lowStockThreshold: true } },
          },
        },
        options: {
          select: { name: true, values: { select: { value: true }, orderBy: { position: 'asc' } } },
        },
      },
    });
    if (!product) {
      throw new AiToolError('Produit introuvable ou indisponible.', 'PRODUCT_NOT_FOUND');
    }

    const result = {
      productId: product.id,
      name: product.name,
      // Catégorie exposée pour permettre au modèle de proposer des alternatives
      // de la MÊME catégorie via search_products en cas de rupture.
      category: product.category?.name ?? null,
      description: (product.shortDescription ?? product.description ?? '').slice(0, 500),
      currency: product.currency,
      options: product.options.map((option) => ({
        name: option.name,
        values: option.values.map((value) => value.value),
      })),
      variants: product.variants.map((variant) => ({
        variantId: variant.id,
        name: variant.name,
        priceMinor: variant.priceMinor,
        compareAtPriceMinor: variant.compareAtPriceMinor,
        allowBackorder: variant.allowBackorder,
        stockStatus: variantStockStatus(variant),
      })),
    };
    return { result, summary: { productId: product.id, variantCount: product.variants.length } };
  },
};

// --- 3. get_variant_availability --------------------------------------------
const getVariantAvailabilityInput = z
  .object({
    variantId: z.string().trim().min(1).max(64),
    quantity: z.number().int().min(1).max(9999).optional(),
  })
  .strict();

const getVariantAvailability: AiToolDefinitionEntry<z.infer<typeof getVariantAvailabilityInput>> = {
  name: 'get_variant_availability',
  description: 'Disponibilité et prix actuels d’une variante précise.',
  parameters: {
    type: 'object',
    properties: {
      variantId: { type: 'string' },
      quantity: { type: 'integer', description: 'Quantité souhaitée (optionnel).' },
    },
    required: ['variantId'],
  },
  inputSchema: getVariantAvailabilityInput,
  async run(prisma, ctx, input): Promise<AiToolRunResult> {
    const variant = await prisma.productVariant.findFirst({
      where: {
        id: input.variantId,
        organizationId: ctx.organizationId,
        shopId: ctx.shopId,
        status: 'ACTIVE',
        archivedAt: null,
        product: { status: 'ACTIVE' },
      },
      select: {
        id: true,
        productId: true,
        priceMinor: true,
        trackInventory: true,
        allowBackorder: true,
        product: { select: { currency: true } },
        inventory: { select: { quantityOnHand: true, quantityReserved: true, lowStockThreshold: true } },
      },
    });
    if (!variant) {
      throw new AiToolError('Variante introuvable ou indisponible.', 'VARIANT_NOT_FOUND');
    }

    const quantityAvailable = variant.inventory
      ? computeQuantityAvailable(variant.inventory)
      : 0;
    const stockStatus = variantStockStatus(variant);
    const canFulfill =
      input.quantity === undefined
        ? undefined
        : variant.allowBackorder || (variant.trackInventory ? quantityAvailable >= input.quantity : true);

    return {
      result: {
        variantId: variant.id,
        productId: variant.productId,
        priceMinor: variant.priceMinor,
        currency: variant.product.currency,
        allowBackorder: variant.allowBackorder,
        stockStatus,
        quantityAvailable: variant.trackInventory ? quantityAvailable : null,
        requestedQuantity: input.quantity ?? null,
        canFulfill: canFulfill ?? null,
      },
      summary: { variantId: variant.id, stockStatus },
    };
  },
};

// --- 4. get_shop_opening_hours ----------------------------------------------
const getShopOpeningHoursInput = z.object({}).strict();

const getShopOpeningHours: AiToolDefinitionEntry<z.infer<typeof getShopOpeningHoursInput>> = {
  name: 'get_shop_opening_hours',
  description: 'Horaires d’ouverture de la boutique et si elle est ouverte maintenant.',
  parameters: { type: 'object', properties: {} },
  inputSchema: getShopOpeningHoursInput,
  async run(prisma, ctx): Promise<AiToolRunResult> {
    const shop = await prisma.shop.findFirst({
      where: { id: ctx.shopId, organizationId: ctx.organizationId },
      select: {
        timezone: true,
        openingHours: {
          select: { dayOfWeek: true, opensAtMinutes: true, closesAtMinutes: true },
          orderBy: [{ dayOfWeek: 'asc' }, { opensAtMinutes: 'asc' }],
        },
      },
    });
    if (!shop) {
      throw new AiToolError('Boutique introuvable.', 'SHOP_NOT_FOUND');
    }

    const ranges: OpeningRange[] = shop.openingHours;
    const state = computeOpenState(ranges, new Date(), shop.timezone);
    const hours = ranges.map((range) => ({
      day: range.dayOfWeek,
      opensAt: minutesToHhmm(range.opensAtMinutes),
      closesAt: minutesToHhmm(range.closesAtMinutes),
    }));

    return {
      result: { timezone: shop.timezone, isOpenNow: state.isOpenNow, hours },
      summary: { isOpenNow: state.isOpenNow, ranges: ranges.length },
    };
  },
};

// --- 5. get_order_status -----------------------------------------------------
const getOrderStatusInput = z.object({ orderNumber: z.string().trim().min(1).max(64) }).strict();

const getOrderStatus: AiToolDefinitionEntry<z.infer<typeof getOrderStatusInput>> = {
  name: 'get_order_status',
  description: 'Statut d’une commande APPARTENANT au client de cette conversation.',
  parameters: {
    type: 'object',
    properties: { orderNumber: { type: 'string' } },
    required: ['orderNumber'],
  },
  inputSchema: getOrderStatusInput,
  async run(prisma, ctx, input): Promise<AiToolRunResult> {
    // Barrière anti-fuite : la commande doit correspondre aux QUATRE clés —
    // organizationId, shopId, contactId ET conversationId. Une commande trouvée
    // par numéro mais rattachée à un autre client/conversation est traitée comme
    // INTROUVABLE (jamais divulguée).
    const order = await prisma.order.findFirst({
      where: {
        orderNumber: input.orderNumber,
        organizationId: ctx.organizationId,
        shopId: ctx.shopId,
        contactId: ctx.contactId,
        conversationId: ctx.conversationId,
      },
      select: {
        orderNumber: true,
        status: true,
        paymentStatus: true,
        fulfillmentStatus: true,
        itemCount: true,
        totalMinor: true,
        currency: true,
        // Adresse, nom, e-mail, notes : JAMAIS sélectionnés.
      },
    });
    if (!order) {
      throw new AiToolError('Commande introuvable pour ce client.', 'ORDER_NOT_FOUND');
    }

    return {
      result: {
        orderNumber: order.orderNumber,
        orderStatus: order.status,
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        itemCount: order.itemCount,
        totalMinor: order.totalMinor,
        currency: order.currency,
      },
      summary: { orderNumber: order.orderNumber, orderStatus: order.status },
    };
  },
};

// --- 6. request_human_handoff (SEULE écriture métier autorisée) --------------
const requestHumanHandoffInput = z
  .object({
    reason: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

const requestHumanHandoff: AiToolDefinitionEntry<z.infer<typeof requestHumanHandoffInput>> = {
  name: 'request_human_handoff',
  description: 'Demande le transfert de la conversation à un conseiller humain.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Motif du transfert.' },
      summary: { type: 'string', description: 'Résumé court (optionnel).' },
    },
    required: ['reason'],
  },
  inputSchema: requestHumanHandoffInput,
  async run(prisma, ctx, input): Promise<AiToolRunResult> {
    // Idempotent : un handoff déjà ouvert (REQUESTED/ACCEPTED) est renvoyé tel
    // quel — jamais un second (l'index partiel le refuserait de toute façon).
    const existing = await prisma.conversationHandoff.findFirst({
      where: {
        conversationId: ctx.conversationId,
        status: { in: ['REQUESTED', 'ACCEPTED'] },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      return {
        result: { handoffId: existing.id, status: existing.status, alreadyOpen: true },
        summary: { handoffId: existing.id, alreadyOpen: true },
      };
    }

    try {
      const handoff = await prisma.conversationHandoff.create({
        data: {
          organizationId: ctx.organizationId,
          shopId: ctx.shopId,
          conversationId: ctx.conversationId,
          aiRunId: ctx.aiRunId,
          status: 'REQUESTED',
          reason: input.reason,
          summary: input.summary ?? null,
        },
        select: { id: true, status: true },
      });
      return {
        result: { handoffId: handoff.id, status: handoff.status, alreadyOpen: false },
        summary: { handoffId: handoff.id, alreadyOpen: false },
      };
    } catch (error) {
      // Course avec un autre run : l'index partiel a tranché → renvoyer l'ouvert.
      const current = await prisma.conversationHandoff.findFirst({
        where: { conversationId: ctx.conversationId, status: { in: ['REQUESTED', 'ACCEPTED'] } },
        select: { id: true, status: true },
      });
      if (current) {
        return {
          result: { handoffId: current.id, status: current.status, alreadyOpen: true },
          summary: { handoffId: current.id, alreadyOpen: true },
        };
      }
      throw error;
    }
  },
};

// --- helpers de filtrage -----------------------------------------------------
interface VariantStockShape {
  trackInventory: boolean;
  allowBackorder: boolean;
  inventory: { quantityOnHand: number; quantityReserved: number; lowStockThreshold: number } | null;
}

function variantStockStatus(variant: VariantStockShape): string {
  return computeVariantStockStatus({
    trackInventory: variant.trackInventory,
    allowBackorder: variant.allowBackorder,
    quantityOnHand: variant.inventory?.quantityOnHand ?? 0,
    quantityReserved: variant.inventory?.quantityReserved ?? 0,
    lowStockThreshold: variant.inventory?.lowStockThreshold ?? 0,
  });
}

function summariseProduct(product: {
  id: string;
  name: string;
  shortDescription: string | null;
  currency: string;
  category: { name: string } | null;
  variants: Array<VariantStockShape & { id: string; name: string | null; priceMinor: number }>;
  images: Array<{ url: string }>;
}): {
  productId: string;
  name: string;
  category: string | null;
  shortDescription: string | null;
  currency: string;
  priceFromMinor: number | null;
  primaryImageUrl: string | null;
  variants: Array<{ variantId: string; name: string | null; priceMinor: number; stockStatus: string }>;
} {
  const variants = product.variants.map((variant) => ({
    variantId: variant.id,
    name: variant.name,
    priceMinor: variant.priceMinor,
    stockStatus: variantStockStatus(variant),
  }));
  const priceFromMinor = variants.length > 0 ? Math.min(...variants.map((v) => v.priceMinor)) : null;
  return {
    productId: product.id,
    name: product.name,
    // Catégorie exposée pour la recommandation d'alternatives (même catégorie).
    category: product.category?.name ?? null,
    shortDescription: product.shortDescription,
    currency: product.currency,
    priceFromMinor,
    primaryImageUrl: product.images[0]?.url ?? null,
    variants,
  };
}

/** Registre : nom → définition. Le modèle ne voit QUE ces outils. */
export const AI_TOOL_REGISTRY: Record<string, AiToolDefinitionEntry> = {
  [searchProducts.name]: searchProducts as AiToolDefinitionEntry,
  [getProductDetails.name]: getProductDetails as AiToolDefinitionEntry,
  [getVariantAvailability.name]: getVariantAvailability as AiToolDefinitionEntry,
  [getShopOpeningHours.name]: getShopOpeningHours as AiToolDefinitionEntry,
  [getOrderStatus.name]: getOrderStatus as AiToolDefinitionEntry,
  [requestHumanHandoff.name]: requestHumanHandoff as AiToolDefinitionEntry,
};

/** Définitions transmises au modèle (function declarations) — lecture seule + handoff. */
export function aiToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return Object.values(AI_TOOL_REGISTRY).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
