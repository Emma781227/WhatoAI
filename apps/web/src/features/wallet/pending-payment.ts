/**
 * Corrélation locale d'une recharge Genius Pay en cours. Avant la redirection
 * vers le checkout (l'app est déchargée), on mémorise l'id du TopUp ; au retour,
 * la page de suivi le relit pour SONDER son statut. Ce marqueur n'est JAMAIS une
 * preuve de paiement — seul le backend (webhook vérifié) confirme. Portée par
 * organisation. Best-effort (localStorage indisponible → ignoré).
 */
const KEY_PREFIX = 'whauto:pending-topup:';

export function setPendingTopUp(organizationId: string, topUpId: string): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + organizationId, topUpId);
  } catch {
    // localStorage indisponible (mode privé, quota) : le webhook + realtime
    // mettront quand même le solde à jour ; on perd seulement le suivi ciblé.
  }
}

export function getPendingTopUp(organizationId: string): string | null {
  try {
    return window.localStorage.getItem(KEY_PREFIX + organizationId);
  } catch {
    return null;
  }
}

export function clearPendingTopUp(organizationId: string): void {
  try {
    window.localStorage.removeItem(KEY_PREFIX + organizationId);
  } catch {
    // ignoré
  }
}
