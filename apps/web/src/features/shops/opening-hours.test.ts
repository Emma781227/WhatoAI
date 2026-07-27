import { describe, expect, it } from 'vitest';

import { normalizeWeek, toMinutes, validateOpeningDays } from './opening-hours';

describe('toMinutes', () => {
  it('convertit HH:mm, bornes incluses', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('08:30')).toBe(510);
    expect(toMinutes('23:59')).toBe(1439);
  });
  it('null pour un format invalide', () => {
    for (const invalid of ['24:00', '8:00', '12:60', '', 'abc']) {
      expect(toMinutes(invalid)).toBeNull();
    }
  });
});

describe('validateOpeningDays', () => {
  it('accepte plusieurs plages non chevauchantes, y compris adjacentes', () => {
    const errors = validateOpeningDays([
      {
        dayOfWeek: 'MONDAY',
        isClosed: false,
        periods: [
          { opensAt: '08:00', closesAt: '12:00' },
          { opensAt: '12:00', closesAt: '18:00' },
        ],
      },
    ]);
    expect(errors).toEqual({});
  });

  it('détecte le chevauchement quel que soit l’ordre de saisie', () => {
    const errors = validateOpeningDays([
      {
        dayOfWeek: 'FRIDAY',
        isClosed: false,
        periods: [
          { opensAt: '14:00', closesAt: '18:00' },
          { opensAt: '08:00', closesAt: '15:00' },
        ],
      },
    ]);
    expect(errors.FRIDAY).toContain('chevauchent');
  });

  it('refuse ouverture ≥ fermeture (pas de plage sur minuit)', () => {
    const errors = validateOpeningDays([
      { dayOfWeek: 'MONDAY', isClosed: false, periods: [{ opensAt: '18:00', closesAt: '08:00' }] },
    ]);
    expect(errors.MONDAY).toBeDefined();
  });

  it('refuse un format d’heure invalide', () => {
    const errors = validateOpeningDays([
      { dayOfWeek: 'MONDAY', isClosed: false, periods: [{ opensAt: '24:00', closesAt: '25:00' }] },
    ]);
    expect(errors.MONDAY).toContain('invalide');
  });

  it('ignore les jours fermés', () => {
    expect(validateOpeningDays([{ dayOfWeek: 'SUNDAY', isClosed: true, periods: [] }])).toEqual({});
  });
});

describe('normalizeWeek', () => {
  it('complète les 7 jours dans l’ordre, jours absents fermés', () => {
    const week = normalizeWeek([
      { dayOfWeek: 'WEDNESDAY', isClosed: false, periods: [{ opensAt: '09:00', closesAt: '17:00' }] },
    ]);
    expect(week).toHaveLength(7);
    expect(week[0].dayOfWeek).toBe('MONDAY');
    expect(week[0].isClosed).toBe(true);
    expect(week[2].isClosed).toBe(false);
    expect(week[6].dayOfWeek).toBe('SUNDAY');
  });
});
