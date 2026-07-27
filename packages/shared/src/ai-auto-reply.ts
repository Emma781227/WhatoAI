/**
 * Catégories d'intention auto-envoyables (sous-phase C — AUTO_REPLY). Liste
 * blanche configurable par Shop : une réponse ne s'auto-envoie que si TOUS les
 * outils qu'elle a utilisés relèvent d'une de ces catégories. Partagé API (DTO)
 * / worker (mapping outil→catégorie) / frontend (réglages) — source unique pour
 * éviter toute dérive entre la validation et l'application.
 */
export const AI_AUTO_REPLY_CATEGORIES = [
  'PRODUCT_INFO',
  'AVAILABILITY',
  'OPENING_HOURS',
  'ORDER_STATUS',
] as const;

export type AiAutoReplyCategory = (typeof AI_AUTO_REPLY_CATEGORIES)[number];
