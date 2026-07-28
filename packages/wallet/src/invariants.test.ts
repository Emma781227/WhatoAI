import { describe, expect, it } from 'vitest';

import { WALLET_MAX_CREDITS } from './constants';
import { InsufficientCreditsError, WalletInvariantViolationError } from './errors';
import { assertCanReserve, computeBalancesAfter } from './invariants';
import { availableCredits } from './types';

describe('computeBalancesAfter — mouvements de crédits', () => {
  it('CREDIT augmente le solde, réservé inchangé', () => {
    expect(computeBalancesAfter({ balanceCredits: 100, reservedCredits: 10 }, { direction: 'CREDIT', amountCredits: 50 })).toEqual({
      balanceCredits: 150,
      reservedCredits: 10,
    });
  });

  it('RESERVE bloque sans toucher au solde', () => {
    expect(computeBalancesAfter({ balanceCredits: 100, reservedCredits: 0 }, { direction: 'RESERVE', amountCredits: 3 })).toEqual({
      balanceCredits: 100,
      reservedCredits: 3,
    });
  });

  it('DEBIT diminue le solde (réservé inchangé)', () => {
    expect(computeBalancesAfter({ balanceCredits: 100, reservedCredits: 0 }, { direction: 'DEBIT', amountCredits: 2 })).toEqual({
      balanceCredits: 98,
      reservedCredits: 0,
    });
  });

  it('RELEASE libère la réservation', () => {
    expect(computeBalancesAfter({ balanceCredits: 100, reservedCredits: 3 }, { direction: 'RELEASE', amountCredits: 3 })).toEqual({
      balanceCredits: 100,
      reservedCredits: 0,
    });
  });

  it('finalisation (release plein puis débit du coût) : reliquat libéré sans double comptage', () => {
    // Réservé 3, coût réel 2 : release 3 → reserved 0, puis debit 2 → balance -2.
    const afterRelease = computeBalancesAfter({ balanceCredits: 10, reservedCredits: 3 }, { direction: 'RELEASE', amountCredits: 3 });
    const afterDebit = computeBalancesAfter(afterRelease, { direction: 'DEBIT', amountCredits: 2 });
    expect(afterDebit).toEqual({ balanceCredits: 8, reservedCredits: 0 });
    expect(availableCredits(afterDebit)).toBe(8);
  });

  it('refuse un montant non entier ou non positif', () => {
    expect(() => computeBalancesAfter({ balanceCredits: 10, reservedCredits: 0 }, { direction: 'CREDIT', amountCredits: 0 })).toThrow(WalletInvariantViolationError);
    expect(() => computeBalancesAfter({ balanceCredits: 10, reservedCredits: 0 }, { direction: 'CREDIT', amountCredits: 1.5 })).toThrow(WalletInvariantViolationError);
    expect(() => computeBalancesAfter({ balanceCredits: 10, reservedCredits: 0 }, { direction: 'DEBIT', amountCredits: -1 })).toThrow(WalletInvariantViolationError);
  });

  it('DEBIT ne peut pas rendre le solde négatif', () => {
    expect(() => computeBalancesAfter({ balanceCredits: 2, reservedCredits: 0 }, { direction: 'DEBIT', amountCredits: 5 })).toThrow(WalletInvariantViolationError);
  });

  it('RESERVE ne peut pas dépasser le solde (réservé <= détenu)', () => {
    expect(() => computeBalancesAfter({ balanceCredits: 3, reservedCredits: 1 }, { direction: 'RESERVE', amountCredits: 3 })).toThrow(WalletInvariantViolationError);
  });

  it('RELEASE ne peut pas rendre le réservé négatif', () => {
    expect(() => computeBalancesAfter({ balanceCredits: 10, reservedCredits: 1 }, { direction: 'RELEASE', amountCredits: 2 })).toThrow(WalletInvariantViolationError);
  });

  it('CREDIT ne peut pas dépasser le plafond', () => {
    expect(() => computeBalancesAfter({ balanceCredits: WALLET_MAX_CREDITS, reservedCredits: 0 }, { direction: 'CREDIT', amountCredits: 1 })).toThrow(WalletInvariantViolationError);
  });
});

describe('assertCanReserve — pré-vérification métier', () => {
  it('passe quand le disponible suffit', () => {
    expect(() => assertCanReserve({ balanceCredits: 10, reservedCredits: 4 }, 3)).not.toThrow();
  });

  it('lève InsufficientCreditsError avec le disponible et le requis', () => {
    try {
      assertCanReserve({ balanceCredits: 5, reservedCredits: 3 }, 3); // dispo = 2 < 3
      throw new Error('aurait dû lever');
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientCreditsError);
      expect((error as InsufficientCreditsError).details).toMatchObject({ availableCredits: 2, requiredCredits: 3, canTopUp: true });
    }
  });
});
