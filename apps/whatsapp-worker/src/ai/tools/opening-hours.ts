import type { DayOfWeek } from '@whauto/database';

/** Une plage d'ouverture (minutes depuis minuit), telle que stockée. */
export interface OpeningRange {
  dayOfWeek: DayOfWeek;
  opensAtMinutes: number;
  closesAtMinutes: number;
}

const WEEKDAY_TO_ENUM: Record<string, DayOfWeek> = {
  Mon: 'MONDAY',
  Tue: 'TUESDAY',
  Wed: 'WEDNESDAY',
  Thu: 'THURSDAY',
  Fri: 'FRIDAY',
  Sat: 'SATURDAY',
  Sun: 'SUNDAY',
};

export interface OpenState {
  isOpenNow: boolean;
  currentDay: DayOfWeek;
  currentMinutes: number;
}

/**
 * Détermine si la boutique est ouverte MAINTENANT, dans SON fuseau horaire.
 * Pur et testable : `now` est injecté. Utilise Intl (aucune dépendance).
 * Un fuseau invalide retombe proprement sur UTC plutôt que de lever.
 */
export function computeOpenState(ranges: OpeningRange[], now: Date, timeZone: string): OpenState {
  let day: DayOfWeek;
  let minutes: number;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Mon';
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24;
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
    day = WEEKDAY_TO_ENUM[weekday] ?? 'MONDAY';
    minutes = hour * 60 + minute;
  } catch {
    day = 'MONDAY';
    minutes = 0;
  }

  const isOpenNow = ranges.some(
    (range) =>
      range.dayOfWeek === day &&
      minutes >= range.opensAtMinutes &&
      minutes < range.closesAtMinutes,
  );
  return { isOpenNow, currentDay: day, currentMinutes: minutes };
}

/** "HH:mm" depuis des minutes (pour un résumé lisible côté modèle). */
export function minutesToHhmm(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}
