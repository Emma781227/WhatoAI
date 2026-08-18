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

const DAY_ORDER: DayOfWeek[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];

const DAY_LABELS: Record<DayOfWeek, string> = {
  MONDAY: 'lun',
  TUESDAY: 'mar',
  WEDNESDAY: 'mer',
  THURSDAY: 'jeu',
  FRIDAY: 'ven',
  SATURDAY: 'sam',
  SUNDAY: 'dim',
};

/**
 * Résumé COMPACT des horaires, injecté directement dans le prompt (CI-G1) :
 * « lun 08:00-18:00 ; mar 08:00-12:00, 14:00-18:00 ; dim fermé ».
 *
 * Pourquoi : sans lui, la moindre question d'horaire coûtait un tour d'outil
 * complet (un aller-retour Gemini facturé) pour une donnée statique. Le modèle
 * garde l'outil détaillé pour « êtes-vous ouverts MAINTENANT ? » (qui dépend de
 * l'heure courante), mais n'en a plus besoin pour réciter les horaires.
 *
 * Renvoie `null` si AUCUNE plage n'est configurée : on ne prétend jamais que la
 * boutique est fermée toute la semaine alors qu'elle n'a rien renseigné.
 */
export function buildOpeningHoursSummary(ranges: OpeningRange[]): string | null {
  if (ranges.length === 0) {
    return null;
  }
  const parts = DAY_ORDER.map((day) => {
    const dayRanges = ranges
      .filter((range) => range.dayOfWeek === day)
      .sort((a, b) => a.opensAtMinutes - b.opensAtMinutes)
      .map((range) => `${minutesToHhmm(range.opensAtMinutes)}-${minutesToHhmm(range.closesAtMinutes)}`);
    return `${DAY_LABELS[day]} ${dayRanges.length > 0 ? dayRanges.join(', ') : 'fermé'}`;
  });
  return parts.join(' ; ');
}

/** "HH:mm" depuis des minutes (pour un résumé lisible côté modèle). */
export function minutesToHhmm(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}
