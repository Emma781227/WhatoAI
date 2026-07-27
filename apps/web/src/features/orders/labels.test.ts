import { describe, expect, it } from 'vitest';

import { isCancellable, nextStatuses } from './labels';

describe('nextStatuses — miroir UI de la table de transitions serveur', () => {
  it('propose READY→SHIPPED pour DELIVERY, READY→DELIVERED pour PICKUP', () => {
    expect(nextStatuses('READY', 'DELIVERY')).toEqual(['SHIPPED']);
    expect(nextStatuses('READY', 'PICKUP')).toEqual(['DELIVERED']);
  });

  it('aucune transition proposée depuis un statut terminal', () => {
    expect(nextStatuses('DELIVERED', 'DELIVERY')).toEqual([]);
    expect(nextStatuses('CANCELLED', 'PICKUP')).toEqual([]);
  });

  it('ne propose jamais CANCELLED (flux d’annulation dédié)', () => {
    for (const status of ['CONFIRMED', 'PROCESSING', 'READY', 'SHIPPED'] as const) {
      expect(nextStatuses(status, 'DELIVERY')).not.toContain('CANCELLED');
    }
  });
});

describe('isCancellable — validé D9', () => {
  it('CONFIRMED, PROCESSING, READY annulables', () => {
    expect(isCancellable('CONFIRMED')).toBe(true);
    expect(isCancellable('PROCESSING')).toBe(true);
    expect(isCancellable('READY')).toBe(true);
  });

  it('SHIPPED, DELIVERED, CANCELLED non annulables', () => {
    expect(isCancellable('SHIPPED')).toBe(false);
    expect(isCancellable('DELIVERED')).toBe(false);
    expect(isCancellable('CANCELLED')).toBe(false);
  });
});
