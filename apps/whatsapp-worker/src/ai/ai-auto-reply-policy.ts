import type { AiAutoReplyScheduleMode } from '@whauto/database';

/**
 * Politique d'auto-réponse (sous-phase C, groupe C2) — PURE et déterministe,
 * testable sans base ni réseau. L'éligibilité AUTO_REPLY repose D'ABORD sur des
 * règles déterministes (fenêtre, horaires, catégorie d'outils, anti-boucle,
 * plafond) ; la `confidence` auto-déclarée par le modèle n'intervient qu'en
 * garde SECONDAIRE (ajustement 16). Le défaut est de NE PAS envoyer : toute
 * condition non satisfaite bloque l'auto-envoi (repli en suggestion humaine).
 */

/**
 * Catégorie d'intention couverte par chaque outil LECTURE SEULE. Sert la liste
 * blanche D3 : une réponse ne s'auto-envoie que si TOUS les outils qu'elle a
 * utilisés appartiennent aux catégories autorisées de la Shop. `request_human_handoff`
 * n'est pas une catégorie de réponse (son usage produit une décision HANDOFF,
 * jamais un auto-envoi) — absent d'ici, il est donc traité comme non autorisé.
 */
export const TOOL_CATEGORY: Record<string, string> = {
  search_products: 'PRODUCT_INFO',
  get_product_details: 'PRODUCT_INFO',
  get_variant_availability: 'AVAILABILITY',
  get_shop_opening_hours: 'OPENING_HOURS',
  get_order_status: 'ORDER_STATUS',
};

/**
 * Plancher de confiance — garde SECONDAIRE uniquement (jamais le critère
 * principal). Une réponse déjà jugée CONSISTENT et adossée aux outils mais
 * marquée peu sûre par le modèle repli en suggestion plutôt que de s'auto-envoyer.
 */
export const AUTO_REPLY_MIN_CONFIDENCE = 0.6;

export type AutoReplySuppressionReason =
  | 'CONVERSATION_PAUSED'
  | 'WINDOW_CLOSED'
  | 'OUTSIDE_BUSINESS_HOURS'
  | 'CATEGORY_NOT_ALLOWED'
  | 'ANTI_MONOLOGUE'
  | 'RATE_LIMIT'
  | 'LOW_CONFIDENCE';

export type AutoReplyGateOutcome =
  | { action: 'SEND' }
  | { action: 'SUPPRESS'; reason: AutoReplySuppressionReason };

export interface AutoReplyGateInput {
  /** Auto-réponse suspendue sur CETTE conversation (reprise humaine ou pause explicite). */
  conversationPaused: boolean;
  /** Liste blanche des catégories auto-envoyables (config Shop). */
  allowedCategories: string[];
  /** Outils réellement appelés pendant le run. */
  usedToolNames: string[];
  /** Confiance auto-déclarée par le modèle (garde secondaire). */
  confidence: number;
  /** Fenêtre 24 h Meta ouverte au moment de la décision. */
  windowOpen: boolean;
  /** Couverture : 24/7 ou uniquement hors horaires d'ouverture. */
  scheduleMode: AiAutoReplyScheduleMode;
  /** La boutique est-elle ouverte MAINTENANT (dans son fuseau) ? */
  isOpenNow: boolean;
  /** Réponses auto déjà envoyées depuis le dernier message client (anti-monologue). */
  autoRepliesSinceLastInbound: number;
  /** Réponses auto envoyées sur cette conversation dans les dernières 24 h. */
  autoRepliesLast24h: number;
  /** Plafond configuré de réponses auto par conversation et par jour. */
  maxPerConversationPerDay: number;
}

/** Toutes les catégories des outils utilisés sont-elles autorisées ? */
function allToolsAllowed(usedToolNames: string[], allowedCategories: string[]): boolean {
  const allowed = new Set(allowedCategories);
  return usedToolNames.every((name) => {
    const category = TOOL_CATEGORY[name];
    return category !== undefined && allowed.has(category);
  });
}

/**
 * Décide si une réponse SUGGEST_REPLY déjà validée (forme + sémantique
 * CONSISTENT) peut être ENVOYÉE automatiquement. Ordre : garde-fous
 * déterministes d'abord (le plus bloquant en premier), confiance en dernier.
 */
export function evaluateAutoReplyGate(input: AutoReplyGateInput): AutoReplyGateOutcome {
  // 0. Reprise humaine / pause explicite : un humain gère cette conversation.
  if (input.conversationPaused) {
    return { action: 'SUPPRESS', reason: 'CONVERSATION_PAUSED' };
  }
  // 1. Fenêtre 24 h Meta : hors fenêtre, aucun texte libre n'est autorisé.
  if (!input.windowOpen) {
    return { action: 'SUPPRESS', reason: 'WINDOW_CLOSED' };
  }
  // 2. Horaires : en mode « hors ouverture », un humain est prioritaire quand la boutique est ouverte.
  if (input.scheduleMode === 'OUTSIDE_BUSINESS_HOURS' && input.isOpenNow) {
    return { action: 'SUPPRESS', reason: 'OUTSIDE_BUSINESS_HOURS' };
  }
  // 3. Catégorie : tout outil utilisé doit être dans la liste blanche.
  if (!allToolsAllowed(input.usedToolNames, input.allowedCategories)) {
    return { action: 'SUPPRESS', reason: 'CATEGORY_NOT_ALLOWED' };
  }
  // 4. Anti-monologue : jamais deux réponses auto sans nouveau message client.
  if (input.autoRepliesSinceLastInbound > 0) {
    return { action: 'SUPPRESS', reason: 'ANTI_MONOLOGUE' };
  }
  // 5. Plafond journalier par conversation.
  if (input.autoRepliesLast24h >= input.maxPerConversationPerDay) {
    return { action: 'SUPPRESS', reason: 'RATE_LIMIT' };
  }
  // 6. Garde secondaire : plancher de confiance.
  if (input.confidence < AUTO_REPLY_MIN_CONFIDENCE) {
    return { action: 'SUPPRESS', reason: 'LOW_CONFIDENCE' };
  }
  return { action: 'SEND' };
}
