/**
 * Constantes du domaine Wallet (pures). Les crédits sont des ENTIERS bornés.
 * Le plafond protège contre les débordements Int PostgreSQL et est répliqué en
 * CHECK SQL (`balanceCredits <= WALLET_MAX_CREDITS`).
 */
export const WALLET_MAX_CREDITS = 1_000_000_000;

/** Version de la sémantique de solde/ledger — indépendante de la tarification IA. */
export const WALLET_LEDGER_VERSION = 'v1';
