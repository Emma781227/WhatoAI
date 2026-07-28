/**
 * Types du domaine Wallet — package PUR (aucune dépendance Prisma/NestJS/DB).
 * Les valeurs miroir des enums Prisma (`WalletStatus`, `WalletTransactionType`,
 * `WalletTransactionDirection`) sont déclarées ici comme sources de vérité
 * partagées API/worker ; la couche Prisma les mappe 1:1 (test de cohérence).
 *
 * Sémantique des soldes (validée) :
 * - `balanceCredits`  = crédits détenus ;
 * - `reservedCredits` = crédits bloqués par une réservation en cours ;
 * - `availableCredits = balanceCredits - reservedCredits`.
 * Réserver NE diminue PAS `balanceCredits`. Finaliser diminue `balanceCredits`
 * du coût réel et libère la réservation (remise à zéro), sans double comptage.
 */

export const WALLET_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type WalletStatus = (typeof WALLET_STATUSES)[number];

export const WALLET_TRANSACTION_TYPES = [
  'CREDIT_PURCHASE',
  'MANUAL_CREDIT',
  'PROMOTIONAL_CREDIT',
  'AI_USAGE_RESERVATION',
  'AI_USAGE_DEBIT',
  'AI_USAGE_RELEASE',
  'REFUND',
  'EXPIRATION',
  'ADJUSTMENT',
  'REVERSAL',
] as const;
export type WalletTransactionType = (typeof WALLET_TRANSACTION_TYPES)[number];

/**
 * Direction = quel(s) champ(s) le mouvement affecte, et dans quel sens :
 * - `CREDIT`  → `balance += amount` ;
 * - `DEBIT`   → `balance -= amount` ;
 * - `RESERVE` → `reserved += amount` ;
 * - `RELEASE` → `reserved -= amount`.
 * Le signe est TOUJOURS porté par la direction ; `amountCredits` est strictement positif.
 */
export const WALLET_TRANSACTION_DIRECTIONS = ['CREDIT', 'DEBIT', 'RESERVE', 'RELEASE'] as const;
export type WalletTransactionDirection = (typeof WALLET_TRANSACTION_DIRECTIONS)[number];

/** Statuts d'une recharge (TopUp). PAID/FAILED/CANCELLED/EXPIRED sont terminaux. */
export const TOPUP_STATUSES = ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED'] as const;
export type TopUpStatus = (typeof TOPUP_STATUSES)[number];

/** Providers de paiement (miroir de `PaymentProviderName` de @whauto/payments). */
export const TOPUP_PROVIDERS = ['MOCK', 'GENIUS_PAY'] as const;
export type TopUpProvider = (typeof TOPUP_PROVIDERS)[number];

/** Soldes courants d'un Wallet (entiers, jamais de flottant). */
export interface WalletBalances {
  balanceCredits: number;
  reservedCredits: number;
}

/** Un mouvement à appliquer sur les soldes. `amountCredits` strictement positif. */
export interface WalletMovement {
  direction: WalletTransactionDirection;
  amountCredits: number;
}

/** Disponible = détenu − bloqué (jamais stocké : toujours dérivé). */
export function availableCredits(balances: WalletBalances): number {
  return balances.balanceCredits - balances.reservedCredits;
}
