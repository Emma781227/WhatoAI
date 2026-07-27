import { describe, expect, it } from 'vitest';

import {
  computeCustomerServiceWindowExpiry,
  isCustomerServiceWindowOpen,
} from './customer-service-window';
import { CUSTOMER_SERVICE_WINDOW_MS } from './whatsapp-constants';

const NOW = new Date('2026-07-17T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

describe('computeCustomerServiceWindowExpiry', () => {
  it('ouvre une fenêtre de 24 h basée sur le timestamp provider, pas sur now', () => {
    const providerTimestamp = new Date(NOW.getTime() - 2 * HOUR);
    const expiry = computeCustomerServiceWindowExpiry({
      providerTimestamp,
      now: NOW,
      currentExpiresAt: null,
    });
    expect(expiry.getTime()).toBe(providerTimestamp.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
  });

  it('prolonge la fenêtre avec un message plus récent', () => {
    const current = new Date(NOW.getTime() + 10 * HOUR);
    const expiry = computeCustomerServiceWindowExpiry({
      providerTimestamp: NOW,
      now: NOW,
      currentExpiresAt: current,
    });
    expect(expiry.getTime()).toBe(NOW.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
  });

  it('un événement ancien (relivraison) ne réduit JAMAIS la fenêtre courante', () => {
    const current = new Date(NOW.getTime() + 20 * HOUR);
    const oldTimestamp = new Date(NOW.getTime() - 10 * HOUR);
    const expiry = computeCustomerServiceWindowExpiry({
      providerTimestamp: oldTimestamp,
      now: NOW,
      currentExpiresAt: current,
    });
    expect(expiry).toBe(current);
  });

  it('borne un timestamp futur aberrant à now (jamais de fenêtre > 24 h)', () => {
    const future = new Date(NOW.getTime() + 5 * HOUR);
    const expiry = computeCustomerServiceWindowExpiry({
      providerTimestamp: future,
      now: NOW,
      currentExpiresAt: null,
    });
    expect(expiry.getTime()).toBe(NOW.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
  });

  it('un timestamp très ancien produit une fenêtre déjà expirée (pas de rejet silencieux)', () => {
    const veryOld = new Date(NOW.getTime() - 40 * 24 * HOUR);
    const expiry = computeCustomerServiceWindowExpiry({
      providerTimestamp: veryOld,
      now: NOW,
      currentExpiresAt: null,
    });
    expect(expiry.getTime()).toBeLessThan(NOW.getTime());
    expect(isCustomerServiceWindowOpen(expiry, NOW)).toBe(false);
  });
});

describe('isCustomerServiceWindowOpen', () => {
  it('null = fenêtre jamais ouverte', () => {
    expect(isCustomerServiceWindowOpen(null, NOW)).toBe(false);
  });

  it('expiration future = ouverte, passée = fermée', () => {
    expect(isCustomerServiceWindowOpen(new Date(NOW.getTime() + 1000), NOW)).toBe(true);
    expect(isCustomerServiceWindowOpen(new Date(NOW.getTime() - 1000), NOW)).toBe(false);
  });
});
