import type {
  TopUpStatus,
  WalletStatus,
  WalletTransactionDirection,
  WalletTransactionType,
} from './types';

/**
 * Transitions de statut du Wallet (pures). CLOSED est terminal. Un Wallet
 * SUSPENDED peut être réactivé ; un Wallet CLOSED ne l'est jamais.
 */
export const WALLET_STATUS_TRANSITIONS: Readonly<Record<WalletStatus, readonly WalletStatus[]>> = {
  ACTIVE: ['SUSPENDED', 'CLOSED'],
  SUSPENDED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

export function canTransitionWalletStatus(from: WalletStatus, to: WalletStatus): boolean {
  return WALLET_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Direction attendue pour chaque type de transaction — garantit qu'un
 * `AI_USAGE_RESERVATION` est bien un RESERVE, un `CREDIT_PURCHASE` un CREDIT, etc.
 * Toute écriture au ledger valide la cohérence type/direction via `isTypeDirectionValid`.
 */
export const WALLET_TRANSACTION_TYPE_DIRECTION: Readonly<
  Record<WalletTransactionType, WalletTransactionDirection>
> = {
  CREDIT_PURCHASE: 'CREDIT',
  MANUAL_CREDIT: 'CREDIT',
  PROMOTIONAL_CREDIT: 'CREDIT',
  AI_USAGE_RESERVATION: 'RESERVE',
  AI_USAGE_DEBIT: 'DEBIT',
  AI_USAGE_RELEASE: 'RELEASE',
  REFUND: 'CREDIT',
  EXPIRATION: 'DEBIT',
  ADJUSTMENT: 'CREDIT', // le sens réel d'un ajustement est porté par la direction fournie
  REVERSAL: 'CREDIT',
};

/**
 * ADJUSTMENT et REVERSAL peuvent aller dans les deux sens (correction) : leur
 * direction n'est donc pas contrainte. Les autres types imposent leur direction.
 */
const FLEXIBLE_DIRECTION_TYPES = new Set<WalletTransactionType>(['ADJUSTMENT', 'REVERSAL']);

export function isTypeDirectionValid(
  type: WalletTransactionType,
  direction: WalletTransactionDirection,
): boolean {
  if (FLEXIBLE_DIRECTION_TYPES.has(type)) {
    return direction === 'CREDIT' || direction === 'DEBIT';
  }
  return WALLET_TRANSACTION_TYPE_DIRECTION[type] === direction;
}

/**
 * Transitions de statut d'un TopUp (machine D5). Un TopUp FAILED/CANCELLED/
 * EXPIRED est terminal pour CETTE tentative (une nouvelle tentative crée un
 * NOUVEAU TopUp). PAID ne redevient jamais PENDING (le Wallet est crédité une
 * fois) ; seul un remboursement provider le fait passer REFUNDED (terminal).
 * REVIEW_REQUIRED (D4 : montant/devise ≠ figé sur un `completed`) est un état de
 * revue manuelle — jamais crédité automatiquement, sans transition automatique.
 */
export const TOPUP_STATUS_TRANSITIONS: Readonly<Record<TopUpStatus, readonly TopUpStatus[]>> = {
  PENDING: ['PROCESSING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REVIEW_REQUIRED'],
  PROCESSING: ['PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REVIEW_REQUIRED'],
  PAID: ['REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
  REFUNDED: [],
  REVIEW_REQUIRED: [],
};

export function canTransitionTopUp(from: TopUpStatus, to: TopUpStatus): boolean {
  return TOPUP_STATUS_TRANSITIONS[from].includes(to);
}

