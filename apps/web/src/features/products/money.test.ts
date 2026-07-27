import { describe, expect, it } from 'vitest';

import { formatMinorAmount, minorToMajorInput, parseMajorToMinor } from './money';

describe('formatMinorAmount — devise pilote les décimales', () => {
  it('XAF (0 décimale) : 5000 = 5 000 FCFA', () => {
    const formatted = formatMinorAmount(5000, 'XAF');
    expect(formatted.replace(/[\u00a0\u202f]/g, ' ')).toContain('5 000');
  });

  it('EUR (2 décimales) : 1299 = 12,99 €', () => {
    const formatted = formatMinorAmount(1299, 'EUR');
    expect(formatted).toContain('12,99');
  });
});

describe('parseMajorToMinor', () => {
  it('XAF : "15000" → 15000 (unité mineure = unité majeure)', () => {
    expect(parseMajorToMinor('15000', 'XAF')).toBe(15000);
    expect(parseMajorToMinor('15 000', 'XAF')).toBe(15000);
  });

  it('EUR : "12,99" → 1299', () => {
    expect(parseMajorToMinor('12,99', 'EUR')).toBe(1299);
    expect(parseMajorToMinor('12.99', 'EUR')).toBe(1299);
  });

  it('refuse les saisies invalides ou négatives', () => {
    expect(parseMajorToMinor('', 'XAF')).toBeNull();
    expect(parseMajorToMinor('abc', 'XAF')).toBeNull();
    expect(parseMajorToMinor('-5', 'XAF')).toBeNull();
    expect(parseMajorToMinor('3000000000', 'XAF')).toBeNull(); // > Int max
  });

  it('aller-retour stable avec minorToMajorInput', () => {
    expect(parseMajorToMinor(minorToMajorInput(1299, 'EUR'), 'EUR')).toBe(1299);
    expect(parseMajorToMinor(minorToMajorInput(5000, 'XAF'), 'XAF')).toBe(5000);
  });
});
