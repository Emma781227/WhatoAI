import { describe, expect, it } from 'vitest';

import { normalizePhoneNumber } from './phone';

describe('normalizePhoneNumber', () => {
  it('normalise un numéro camerounais E.164', () => {
    expect(normalizePhoneNumber('+237650123456')).toBe('+237650123456');
  });

  it('accepte les espaces et tirets de présentation', () => {
    expect(normalizePhoneNumber('+237 650 12 34 56')).toBe('+237650123456');
    expect(normalizePhoneNumber('+33 6-12-34-56-78')).toBe('+33612345678');
  });

  it('accepte un wa_id sans "+" (format WhatsApp)', () => {
    expect(normalizePhoneNumber('237650123456')).toBe('+237650123456');
    expect(normalizePhoneNumber('33612345678')).toBe('+33612345678');
  });

  it('refuse un numéro local sans indicatif pays (jamais deviner)', () => {
    expect(normalizePhoneNumber('0612345678')).toBeNull();
  });

  it('refuse les numéros invalides', () => {
    expect(normalizePhoneNumber('')).toBeNull();
    expect(normalizePhoneNumber('abc')).toBeNull();
    expect(normalizePhoneNumber('+123')).toBeNull();
    expect(normalizePhoneNumber('+23765012345699999')).toBeNull();
  });

  it('deux écritures du même numéro produisent la même forme canonique', () => {
    expect(normalizePhoneNumber('+237 650123456')).toBe(normalizePhoneNumber('237650123456'));
  });
});
