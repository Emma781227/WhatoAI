/**
 * Tarification des runs IA en CRÉDITS — PURE, déterministe, VERSIONNÉE. C'est la
 * « stratégie » AiCreditPricingService : jamais dans le contrôleur ni
 * l'orchestrateur, jamais de coût fournisseur (tokens Gemini) codé en dur comme
 * unité commerciale. Le client raisonne en crédits, pas en tokens.
 *
 * Grille v1 (D5 validée) — basée sur le nombre réel d'OUTILS RÉUSSIS
 * (`successfulToolCalls`), PAS sur `toolRounds` :
 *   - SUGGEST_REPLY sans outil            → 1 crédit ;
 *   - SUGGEST_REPLY avec 1 outil réussi   → 2 crédits ;
 *   - SUGGEST_REPLY avec ≥2 outils réussis → 3 crédits (plafond `MAX_CREDITS_PER_AI_RUN`).
 * Tout run qui ne PRODUIT PAS une réponse (HANDOFF, NO_REPLY, FAILED,
 * SUPERSEDED, SKIPPED) n'est PAS facturé. Une suggestion produite puis rejetée
 * par l'agent reste facturée (l'appel IA a eu lieu).
 */
export const AI_CREDIT_PRICING_VERSION = 'v1';

/** Montant maximal réservable/facturable par run (borne de la grille v1). */
export const MAX_CREDITS_PER_AI_RUN = 3;

/** Issue facturable d'un run : seul SUGGEST_REPLY (auto-envoyé OU suggéré) est facturé. */
export type AiRunBillableOutcome =
  | 'SUGGEST_REPLY'
  | 'HANDOFF'
  | 'NO_REPLY'
  | 'FAILED'
  | 'SUPERSEDED'
  | 'SKIPPED';

export type AiPricingReasonCode =
  | 'SUGGEST_REPLY_NO_TOOL'
  | 'SUGGEST_REPLY_ONE_TOOL'
  | 'SUGGEST_REPLY_MULTI_TOOL'
  | 'NOT_BILLABLE_HANDOFF'
  | 'NOT_BILLABLE_NO_REPLY'
  | 'NOT_BILLABLE_FAILED'
  | 'NOT_BILLABLE_SUPERSEDED'
  | 'NOT_BILLABLE_SKIPPED';

export interface AiRunPricingInput {
  outcome: AiRunBillableOutcome;
  /** Nombre d'OUTILS RÉUSSIS (AiToolCall SUCCEEDED) — jamais les rounds seuls. */
  successfulToolCalls: number;
}

export interface AiRunPricingResult {
  creditsRequired: number;
  pricingVersion: string;
  reasonCode: AiPricingReasonCode;
}

const NOT_BILLABLE_REASON: Record<Exclude<AiRunBillableOutcome, 'SUGGEST_REPLY'>, AiPricingReasonCode> = {
  HANDOFF: 'NOT_BILLABLE_HANDOFF',
  NO_REPLY: 'NOT_BILLABLE_NO_REPLY',
  FAILED: 'NOT_BILLABLE_FAILED',
  SUPERSEDED: 'NOT_BILLABLE_SUPERSEDED',
  SKIPPED: 'NOT_BILLABLE_SKIPPED',
};

/** Calcule le coût en crédits d'un run IA (déterministe, versionné). */
export function computeAiRunCredits(input: AiRunPricingInput): AiRunPricingResult {
  if (input.outcome !== 'SUGGEST_REPLY') {
    return {
      creditsRequired: 0,
      pricingVersion: AI_CREDIT_PRICING_VERSION,
      reasonCode: NOT_BILLABLE_REASON[input.outcome],
    };
  }

  const tools = Math.max(0, Math.floor(input.successfulToolCalls));
  let creditsRequired: number;
  let reasonCode: AiPricingReasonCode;
  if (tools <= 0) {
    creditsRequired = 1;
    reasonCode = 'SUGGEST_REPLY_NO_TOOL';
  } else if (tools === 1) {
    creditsRequired = 2;
    reasonCode = 'SUGGEST_REPLY_ONE_TOOL';
  } else {
    creditsRequired = MAX_CREDITS_PER_AI_RUN;
    reasonCode = 'SUGGEST_REPLY_MULTI_TOOL';
  }

  return {
    creditsRequired: Math.min(creditsRequired, MAX_CREDITS_PER_AI_RUN),
    pricingVersion: AI_CREDIT_PRICING_VERSION,
    reasonCode,
  };
}
