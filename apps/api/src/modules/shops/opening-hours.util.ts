import type { DayOfWeek } from '@whauto/database';
import { InvalidOpeningHoursError, OverlappingOpeningHoursError } from '@whauto/shared';

export const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const MINUTES_PER_DAY = 24 * 60;

/** "08:30" → 510. Lève une erreur métier si le format est invalide. */
export function parseHHmm(value: string): number {
  if (!HHMM_PATTERN.test(value)) {
    throw new InvalidOpeningHoursError(`"${value}" is not a valid HH:mm time`);
  }
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

/** 510 → "08:30". */
export function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, '0');
  const minutes = (totalMinutes % 60).toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

export interface NormalizedPeriod {
  dayOfWeek: DayOfWeek;
  opensAtMinutes: number;
  closesAtMinutes: number;
}

export interface DayInput {
  dayOfWeek: DayOfWeek;
  isClosed: boolean;
  periods: Array<{ opensAt: string; closesAt: string }>;
}

/**
 * Valide et normalise le remplacement complet des horaires :
 * - jours non dupliqués ;
 * - jour fermé sans plage / jour ouvert avec au moins une plage ;
 * - format HH:mm, opensAt < closesAt (pas de plage traversant minuit) ;
 * - aucune plage chevauchante dans une même journée (plages adjacentes OK).
 *
 * Retourne les lignes à insérer : un jour fermé ne produit AUCUNE ligne.
 */
export function normalizeOpeningHours(days: DayInput[]): NormalizedPeriod[] {
  const seenDays = new Set<DayOfWeek>();
  const rows: NormalizedPeriod[] = [];

  for (const day of days) {
    if (seenDays.has(day.dayOfWeek)) {
      throw new InvalidOpeningHoursError(`day ${day.dayOfWeek} is declared more than once`);
    }
    seenDays.add(day.dayOfWeek);

    if (day.isClosed) {
      if (day.periods.length > 0) {
        throw new InvalidOpeningHoursError(
          `day ${day.dayOfWeek} is marked closed but declares periods`,
        );
      }
      continue;
    }

    if (day.periods.length === 0) {
      throw new InvalidOpeningHoursError(
        `day ${day.dayOfWeek} is open but declares no period (mark it closed instead)`,
      );
    }

    const periods = day.periods
      .map((period) => ({
        dayOfWeek: day.dayOfWeek,
        opensAtMinutes: parseHHmm(period.opensAt),
        closesAtMinutes: parseHHmm(period.closesAt),
      }))
      .sort((a, b) => a.opensAtMinutes - b.opensAtMinutes);

    for (const period of periods) {
      if (period.opensAtMinutes >= period.closesAtMinutes) {
        throw new InvalidOpeningHoursError(
          `on ${day.dayOfWeek}, opening time must be strictly before closing time (periods crossing midnight are not supported)`,
        );
      }
    }
    for (let index = 1; index < periods.length; index += 1) {
      // Plages triées : chevauchement si la suivante commence avant la fin
      // de la précédente. Adjacentes (12:00/12:00) acceptées.
      if (periods[index].opensAtMinutes < periods[index - 1].closesAtMinutes) {
        throw new OverlappingOpeningHoursError(day.dayOfWeek);
      }
    }

    rows.push(...periods);
  }

  return rows;
}
