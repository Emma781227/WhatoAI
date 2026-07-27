/**
 * Transitions de statut Message — source unique de vérité, partagée par
 * l'API (updates conditionnels), le worker (processors) et le frontend
 * (réconciliation : un statut ne recule jamais dans le cache).
 *
 * Cycle sortant : PENDING → QUEUED → SENT → DELIVERED → READ.
 * FAILED est atteignable depuis PENDING/QUEUED (et SENT uniquement sur
 * événement fournisseur explicite). FAILED → PENDING existe uniquement via
 * l'endpoint retry explicite. RECEIVED (entrant) est terminal.
 *
 * Types en littéraux de chaîne (pas d'import Prisma) : ce package est aussi
 * consommé par le frontend.
 */

export type MessageStatusValue =
  | 'RECEIVED'
  | 'PENDING'
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED';

export type OutboundProgressStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ';

/** Rang de progression du cycle sortant. RECEIVED et FAILED n'en font pas partie. */
const OUTBOUND_STATUS_RANK: Readonly<Record<string, number>> = {
  PENDING: 0,
  QUEUED: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
};

/**
 * Statuts depuis lesquels la progression vers `target` est autorisée.
 * À utiliser dans un `updateMany({ where: { status: { in: ... } } })` :
 * un `count === 0` signifie "déjà appliqué ou interdit", jamais une erreur.
 */
export function statusesUpgradableTo(target: OutboundProgressStatus): MessageStatusValue[] {
  const targetRank = OUTBOUND_STATUS_RANK[target];
  return (Object.keys(OUTBOUND_STATUS_RANK) as MessageStatusValue[]).filter(
    (status) => OUTBOUND_STATUS_RANK[status] < targetRank,
  );
}

/** Statuts depuis lesquels le passage à FAILED est autorisé. */
export function statusesFailableFrom(options?: { providerConfirmed?: boolean }): MessageStatusValue[] {
  // SENT → FAILED uniquement si un événement fournisseur cohérent le justifie.
  return options?.providerConfirmed ? ['PENDING', 'QUEUED', 'SENT'] : ['PENDING', 'QUEUED'];
}

/**
 * La transition `from` → `to` est-elle une progression valide ?
 * Utilisée par le frontend pour ne jamais rétrograder un statut affiché
 * (un DELIVERED arrivé après un READ est ignoré).
 */
export function isStatusUpgrade(from: MessageStatusValue, to: MessageStatusValue): boolean {
  if (from === to) return false;
  if (from === 'RECEIVED' || to === 'RECEIVED') return false;
  if (to === 'FAILED') return statusesFailableFrom({ providerConfirmed: true }).includes(from);
  if (from === 'FAILED') return false; // retry explicite uniquement (côté serveur)
  return OUTBOUND_STATUS_RANK[to] > OUTBOUND_STATUS_RANK[from];
}
