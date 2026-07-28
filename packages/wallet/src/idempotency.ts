/**
 * Constructeurs de clés d'idempotence (purs, déterministes). Chaque mouvement de
 * crédits porte une `idempotencyKey` UNIQUE en base : rejouer la même opération
 * (webhook paiement, retry BullMQ, AiRun rejoué, double confirmation) ne produit
 * JAMAIS un second mouvement. Les clés sont stables : mêmes entrées → même clé.
 */

/** Réservation de crédits pour un run IA — une seule par run. */
export function aiUsageReservationKey(aiRunId: string): string {
  return `ai-usage:reserve:${aiRunId}`;
}

/** Débit final d'un run IA — un seul par run. */
export function aiUsageDebitKey(aiRunId: string): string {
  return `ai-usage:debit:${aiRunId}`;
}

/** Libération du reliquat de réservation d'un run IA — une seule par run. */
export function aiUsageReleaseKey(aiRunId: string): string {
  return `ai-usage:release:${aiRunId}`;
}

/** Crédit consécutif à un TopUp payé — un seul crédit par TopUp. */
export function topUpCreditKey(topUpId: string): string {
  return `topup:credit:${topUpId}`;
}

/** Crédit manuel plateforme — la clé est fournie par l'appelant (opération admin). */
export function manualCreditKey(externalKey: string): string {
  return `manual:credit:${externalKey}`;
}
