import { describe, expect, it } from 'vitest';

import { canTransitionTopUp, canTransitionWalletStatus, isTypeDirectionValid } from './transitions';
import { WALLET_TRANSACTION_TYPES } from './types';

describe('transitions de statut Wallet', () => {
  it('ACTIVE ⇄ SUSPENDED, → CLOSED', () => {
    expect(canTransitionWalletStatus('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canTransitionWalletStatus('SUSPENDED', 'ACTIVE')).toBe(true);
    expect(canTransitionWalletStatus('ACTIVE', 'CLOSED')).toBe(true);
  });

  it('CLOSED est terminal', () => {
    expect(canTransitionWalletStatus('CLOSED', 'ACTIVE')).toBe(false);
    expect(canTransitionWalletStatus('CLOSED', 'SUSPENDED')).toBe(false);
  });
});

describe('cohérence type ↔ direction', () => {
  it('chaque type non flexible impose sa direction', () => {
    expect(isTypeDirectionValid('CREDIT_PURCHASE', 'CREDIT')).toBe(true);
    expect(isTypeDirectionValid('CREDIT_PURCHASE', 'DEBIT')).toBe(false);
    expect(isTypeDirectionValid('AI_USAGE_RESERVATION', 'RESERVE')).toBe(true);
    expect(isTypeDirectionValid('AI_USAGE_RESERVATION', 'CREDIT')).toBe(false);
    expect(isTypeDirectionValid('AI_USAGE_DEBIT', 'DEBIT')).toBe(true);
    expect(isTypeDirectionValid('AI_USAGE_RELEASE', 'RELEASE')).toBe(true);
  });

  it('ADJUSTMENT / REVERSAL acceptent CREDIT ou DEBIT, jamais RESERVE/RELEASE', () => {
    expect(isTypeDirectionValid('ADJUSTMENT', 'CREDIT')).toBe(true);
    expect(isTypeDirectionValid('ADJUSTMENT', 'DEBIT')).toBe(true);
    expect(isTypeDirectionValid('ADJUSTMENT', 'RESERVE')).toBe(false);
    expect(isTypeDirectionValid('REVERSAL', 'RELEASE')).toBe(false);
  });

  it('tous les types ont une règle de direction', () => {
    for (const type of WALLET_TRANSACTION_TYPES) {
      const anyValid = (['CREDIT', 'DEBIT', 'RESERVE', 'RELEASE'] as const).some((d) =>
        isTypeDirectionValid(type, d),
      );
      expect(anyValid).toBe(true);
    }
  });
});

describe('transitions TopUp', () => {
  it('PENDING → PAID/FAILED/CANCELLED/EXPIRED/PROCESSING', () => {
    expect(canTransitionTopUp('PENDING', 'PAID')).toBe(true);
    expect(canTransitionTopUp('PENDING', 'FAILED')).toBe(true);
    expect(canTransitionTopUp('PROCESSING', 'PAID')).toBe(true);
  });

  it('les statuts terminaux ne transitionnent plus (PAID jamais recyclé)', () => {
    expect(canTransitionTopUp('PAID', 'PENDING')).toBe(false);
    expect(canTransitionTopUp('PAID', 'FAILED')).toBe(false);
    expect(canTransitionTopUp('FAILED', 'PAID')).toBe(false);
    expect(canTransitionTopUp('CANCELLED', 'PAID')).toBe(false);
    expect(canTransitionTopUp('EXPIRED', 'PAID')).toBe(false);
  });
});
