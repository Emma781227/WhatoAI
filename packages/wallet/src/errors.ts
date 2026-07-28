import { DomainError } from '@whauto/shared';

/**
 * Erreurs métier du Wallet (étendent `DomainError` de `@whauto/shared`, donc
 * mappées par le `DomainErrorFilter` global : `statusCode` + `code` + `message`,
 * jamais de détail interne ni de secret).
 */

export class WalletNotFoundError extends DomainError {
  constructor() {
    super('Wallet not found.', 'WALLET_NOT_FOUND', 404);
    this.name = 'WalletNotFoundError';
  }
}

export class WalletSuspendedError extends DomainError {
  constructor() {
    super('The wallet is suspended.', 'WALLET_SUSPENDED', 409);
    this.name = 'WalletSuspendedError';
  }
}

export class WalletClosedError extends DomainError {
  constructor() {
    super('The wallet is closed.', 'WALLET_CLOSED', 409);
    this.name = 'WalletClosedError';
  }
}

/** 422 : solde disponible insuffisant pour réserver/débiter le montant demandé. */
export class InsufficientCreditsError extends DomainError {
  constructor(availableCredits: number, requiredCredits: number) {
    super('Insufficient credit balance.', 'INSUFFICIENT_CREDITS', 422, {
      availableCredits,
      requiredCredits,
      canTopUp: true,
    });
    this.name = 'InsufficientCreditsError';
  }
}

/** 409 : conflit de version optimiste sur le Wallet (deux mutations concurrentes). */
export class WalletConcurrencyError extends DomainError {
  constructor() {
    super('The wallet was modified concurrently, please retry.', 'WALLET_CONCURRENCY', 409);
    this.name = 'WalletConcurrencyError';
  }
}

/** 409 : une transaction avec cette idempotencyKey existe déjà (rejeu). */
export class WalletTransactionAlreadyExistsError extends DomainError {
  constructor() {
    super('This wallet transaction was already recorded.', 'WALLET_TRANSACTION_EXISTS', 409);
    this.name = 'WalletTransactionAlreadyExistsError';
  }
}

/**
 * 500 : un invariant de solde serait violé (négatif, réservé > détenu, plafond
 * dépassé, combinaison type/direction interdite). Ne devrait JAMAIS remonter au
 * client normalement — les pré-vérifications l'anticipent — mais c'est le dernier
 * rempart, doublé par les CHECK SQL.
 */
export class WalletInvariantViolationError extends DomainError {
  constructor(reasonCode: string) {
    super('Wallet invariant violation.', 'WALLET_INVARIANT_VIOLATION', 500, { reasonCode });
    this.name = 'WalletInvariantViolationError';
  }
}

// ── CreditPackage / TopUp (groupe 2) ────────────────────────────────────────

export class CreditPackageNotFoundError extends DomainError {
  constructor() {
    super('Credit package not found.', 'CREDIT_PACKAGE_NOT_FOUND', 404);
    this.name = 'CreditPackageNotFoundError';
  }
}

export class CreditPackageInactiveError extends DomainError {
  constructor() {
    super('This credit package is no longer available.', 'CREDIT_PACKAGE_INACTIVE', 409);
    this.name = 'CreditPackageInactiveError';
  }
}

export class TopUpNotFoundError extends DomainError {
  constructor() {
    super('Top-up not found.', 'TOPUP_NOT_FOUND', 404);
    this.name = 'TopUpNotFoundError';
  }
}

/** 409 : un TopUp déjà PAID ne peut être recrédité (le Wallet n'est crédité qu'une fois). */
export class TopUpAlreadyPaidError extends DomainError {
  constructor() {
    super('This top-up has already been paid.', 'TOPUP_ALREADY_PAID', 409);
    this.name = 'TopUpAlreadyPaidError';
  }
}

export class TopUpInvalidTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super(`Invalid top-up transition (${from} → ${to}).`, 'TOPUP_INVALID_TRANSITION', 409);
    this.name = 'TopUpInvalidTransitionError';
  }
}
