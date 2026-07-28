import { WALLET_MAX_CREDITS } from './constants';
import { InsufficientCreditsError, WalletInvariantViolationError } from './errors';
import { availableCredits, type WalletBalances, type WalletMovement } from './types';

/**
 * Invariants de solde — PURS et déterministes. Dernier rempart applicatif,
 * DOUBLÉ par les CHECK SQL. Toute mutation de Wallet DOIT passer par
 * `computeBalancesAfter` pour obtenir les nouveaux soldes ET valider :
 *   balance >= 0 · reserved >= 0 · reserved <= balance · balance <= plafond.
 * `amountCredits` est toujours strictement positif ; le sens vient de la direction.
 */

function assertPositiveInteger(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new WalletInvariantViolationError('AMOUNT_NOT_POSITIVE_INTEGER');
  }
}

function assertBalancesValid(b: WalletBalances, at: string): void {
  if (!Number.isInteger(b.balanceCredits) || !Number.isInteger(b.reservedCredits)) {
    throw new WalletInvariantViolationError(`${at}:BALANCES_NOT_INTEGER`);
  }
  if (b.balanceCredits < 0) throw new WalletInvariantViolationError(`${at}:BALANCE_NEGATIVE`);
  if (b.reservedCredits < 0) throw new WalletInvariantViolationError(`${at}:RESERVED_NEGATIVE`);
  if (b.reservedCredits > b.balanceCredits) {
    throw new WalletInvariantViolationError(`${at}:RESERVED_EXCEEDS_BALANCE`);
  }
  if (b.balanceCredits > WALLET_MAX_CREDITS) {
    throw new WalletInvariantViolationError(`${at}:BALANCE_CAP_EXCEEDED`);
  }
}

/** Applique un mouvement et renvoie les nouveaux soldes, ou lève un invariant. */
export function computeBalancesAfter(
  current: WalletBalances,
  movement: WalletMovement,
): WalletBalances {
  assertPositiveInteger(movement.amountCredits);
  assertBalancesValid(current, 'BEFORE');

  let next: WalletBalances;
  switch (movement.direction) {
    case 'CREDIT':
      next = {
        balanceCredits: current.balanceCredits + movement.amountCredits,
        reservedCredits: current.reservedCredits,
      };
      break;
    case 'DEBIT':
      next = {
        balanceCredits: current.balanceCredits - movement.amountCredits,
        reservedCredits: current.reservedCredits,
      };
      break;
    case 'RESERVE':
      next = {
        balanceCredits: current.balanceCredits,
        reservedCredits: current.reservedCredits + movement.amountCredits,
      };
      break;
    case 'RELEASE':
      next = {
        balanceCredits: current.balanceCredits,
        reservedCredits: current.reservedCredits - movement.amountCredits,
      };
      break;
    default:
      throw new WalletInvariantViolationError('UNKNOWN_DIRECTION');
  }

  assertBalancesValid(next, `AFTER_${movement.direction}`);
  return next;
}

/**
 * Pré-vérification MÉTIER (avant une réservation) : lève `InsufficientCreditsError`
 * si le disponible est insuffisant. À appeler SOUS verrou `FOR UPDATE` du Wallet,
 * avant `computeBalancesAfter`, pour renvoyer une erreur claire plutôt qu'un
 * invariant brut.
 */
export function assertCanReserve(current: WalletBalances, amount: number): void {
  assertPositiveInteger(amount);
  if (availableCredits(current) < amount) {
    throw new InsufficientCreditsError(availableCredits(current), amount);
  }
}
