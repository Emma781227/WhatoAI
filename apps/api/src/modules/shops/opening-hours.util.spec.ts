import { InvalidOpeningHoursError, OverlappingOpeningHoursError } from '@whauto/shared';

import { formatMinutes, normalizeOpeningHours, parseHHmm } from './opening-hours.util';

describe('opening-hours.util', () => {
  describe('parseHHmm / formatMinutes', () => {
    it('convertit dans les deux sens, bornes incluses', () => {
      expect(parseHHmm('00:00')).toBe(0);
      expect(parseHHmm('08:30')).toBe(510);
      expect(parseHHmm('23:59')).toBe(1439);
      expect(formatMinutes(0)).toBe('00:00');
      expect(formatMinutes(510)).toBe('08:30');
      expect(formatMinutes(1439)).toBe('23:59');
    });

    it('rejette les formats invalides', () => {
      for (const invalid of ['24:00', '8:00', '12:60', '12h00', '', '99:99']) {
        expect(() => parseHHmm(invalid)).toThrow(InvalidOpeningHoursError);
      }
    });
  });

  describe('normalizeOpeningHours', () => {
    it('produit une ligne par plage et aucune pour un jour fermé', () => {
      const rows = normalizeOpeningHours([
        {
          dayOfWeek: 'MONDAY',
          isClosed: false,
          periods: [
            { opensAt: '08:00', closesAt: '12:00' },
            { opensAt: '14:00', closesAt: '18:00' },
          ],
        },
        { dayOfWeek: 'SUNDAY', isClosed: true, periods: [] },
      ]);

      expect(rows).toEqual([
        { dayOfWeek: 'MONDAY', opensAtMinutes: 480, closesAtMinutes: 720 },
        { dayOfWeek: 'MONDAY', opensAtMinutes: 840, closesAtMinutes: 1080 },
      ]);
    });

    it('rejette un jour dupliqué', () => {
      expect(() =>
        normalizeOpeningHours([
          { dayOfWeek: 'MONDAY', isClosed: true, periods: [] },
          { dayOfWeek: 'MONDAY', isClosed: true, periods: [] },
        ]),
      ).toThrow(InvalidOpeningHoursError);
    });

    it('rejette un jour fermé avec des plages, et un jour ouvert sans plage', () => {
      expect(() =>
        normalizeOpeningHours([
          { dayOfWeek: 'MONDAY', isClosed: true, periods: [{ opensAt: '08:00', closesAt: '12:00' }] },
        ]),
      ).toThrow(InvalidOpeningHoursError);
      expect(() =>
        normalizeOpeningHours([{ dayOfWeek: 'MONDAY', isClosed: false, periods: [] }]),
      ).toThrow(InvalidOpeningHoursError);
    });

    it('rejette opensAt >= closesAt (pas de plage traversant minuit)', () => {
      expect(() =>
        normalizeOpeningHours([
          { dayOfWeek: 'MONDAY', isClosed: false, periods: [{ opensAt: '18:00', closesAt: '08:00' }] },
        ]),
      ).toThrow(InvalidOpeningHoursError);
      expect(() =>
        normalizeOpeningHours([
          { dayOfWeek: 'MONDAY', isClosed: false, periods: [{ opensAt: '12:00', closesAt: '12:00' }] },
        ]),
      ).toThrow(InvalidOpeningHoursError);
    });

    it('rejette les plages chevauchantes, quel que soit leur ordre de déclaration', () => {
      expect(() =>
        normalizeOpeningHours([
          {
            dayOfWeek: 'FRIDAY',
            isClosed: false,
            periods: [
              { opensAt: '14:00', closesAt: '18:00' },
              { opensAt: '08:00', closesAt: '15:00' },
            ],
          },
        ]),
      ).toThrow(OverlappingOpeningHoursError);
    });

    it('accepte des plages adjacentes (12:00-12:00)', () => {
      const rows = normalizeOpeningHours([
        {
          dayOfWeek: 'MONDAY',
          isClosed: false,
          periods: [
            { opensAt: '08:00', closesAt: '12:00' },
            { opensAt: '12:00', closesAt: '18:00' },
          ],
        },
      ]);
      expect(rows).toHaveLength(2);
    });
  });
});
