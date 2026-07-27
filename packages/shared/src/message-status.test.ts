import { describe, expect, it } from 'vitest';

import {
  isStatusUpgrade,
  statusesFailableFrom,
  statusesUpgradableTo,
} from './message-status';

describe('statusesUpgradableTo', () => {
  it('QUEUED atteignable uniquement depuis PENDING', () => {
    expect(statusesUpgradableTo('QUEUED')).toEqual(['PENDING']);
  });

  it('SENT atteignable depuis PENDING et QUEUED', () => {
    expect(statusesUpgradableTo('SENT')).toEqual(['PENDING', 'QUEUED']);
  });

  it('READ atteignable depuis tous les statuts antérieurs (out-of-order toléré)', () => {
    expect(statusesUpgradableTo('READ')).toEqual(['PENDING', 'QUEUED', 'SENT', 'DELIVERED']);
  });

  it('jamais de rétrogradation : DELIVERED ne fait pas partie des prédécesseurs de SENT', () => {
    expect(statusesUpgradableTo('SENT')).not.toContain('DELIVERED');
    expect(statusesUpgradableTo('SENT')).not.toContain('READ');
  });

  it('RECEIVED et FAILED ne participent jamais à la progression sortante', () => {
    for (const target of ['QUEUED', 'SENT', 'DELIVERED', 'READ'] as const) {
      expect(statusesUpgradableTo(target)).not.toContain('RECEIVED');
      expect(statusesUpgradableTo(target)).not.toContain('FAILED');
    }
  });
});

describe('statusesFailableFrom', () => {
  it('PENDING et QUEUED sont toujours failables', () => {
    expect(statusesFailableFrom()).toEqual(['PENDING', 'QUEUED']);
  });

  it('SENT → FAILED uniquement sur événement fournisseur explicite', () => {
    expect(statusesFailableFrom()).not.toContain('SENT');
    expect(statusesFailableFrom({ providerConfirmed: true })).toContain('SENT');
  });

  it('DELIVERED et READ ne sont jamais failables', () => {
    expect(statusesFailableFrom({ providerConfirmed: true })).not.toContain('DELIVERED');
    expect(statusesFailableFrom({ providerConfirmed: true })).not.toContain('READ');
  });
});

describe('isStatusUpgrade (réconciliation frontend)', () => {
  it('progression normale acceptée', () => {
    expect(isStatusUpgrade('PENDING', 'QUEUED')).toBe(true);
    expect(isStatusUpgrade('QUEUED', 'SENT')).toBe(true);
    expect(isStatusUpgrade('SENT', 'DELIVERED')).toBe(true);
    expect(isStatusUpgrade('DELIVERED', 'READ')).toBe(true);
    expect(isStatusUpgrade('PENDING', 'READ')).toBe(true);
  });

  it('rétrogradation toujours refusée (READ → SENT, DELIVERED → QUEUED)', () => {
    expect(isStatusUpgrade('READ', 'SENT')).toBe(false);
    expect(isStatusUpgrade('DELIVERED', 'QUEUED')).toBe(false);
    expect(isStatusUpgrade('SENT', 'PENDING')).toBe(false);
  });

  it('même statut : pas une progression (événement dupliqué ignoré)', () => {
    expect(isStatusUpgrade('SENT', 'SENT')).toBe(false);
  });

  it('FAILED → SENT refusé sans retry explicite', () => {
    expect(isStatusUpgrade('FAILED', 'SENT')).toBe(false);
  });

  it('FAILED accepté depuis les statuts failables', () => {
    expect(isStatusUpgrade('PENDING', 'FAILED')).toBe(true);
    expect(isStatusUpgrade('QUEUED', 'FAILED')).toBe(true);
    expect(isStatusUpgrade('SENT', 'FAILED')).toBe(true);
    expect(isStatusUpgrade('READ', 'FAILED')).toBe(false);
  });

  it('RECEIVED (entrant) est terminal dans les deux sens', () => {
    expect(isStatusUpgrade('RECEIVED', 'READ')).toBe(false);
    expect(isStatusUpgrade('SENT', 'RECEIVED')).toBe(false);
  });
});
