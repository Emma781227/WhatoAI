import type { DayOfWeek, OpeningHourDay } from './api';

export const WEEK_DAYS: DayOfWeek[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];

export const DAY_LABELS: Record<DayOfWeek, string> = {
  MONDAY: 'Lundi',
  TUESDAY: 'Mardi',
  WEDNESDAY: 'Mercredi',
  THURSDAY: 'Jeudi',
  FRIDAY: 'Vendredi',
  SATURDAY: 'Samedi',
  SUNDAY: 'Dimanche',
};

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function toMinutes(value: string): number | null {
  if (!HHMM_PATTERN.test(value)) {
    return null;
  }
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Validation miroir du backend (jamais plus permissive) : format HH:mm,
 * ouverture strictement avant fermeture, pas de chevauchement dans la journée
 * (plages adjacentes acceptées). Retourne un message par jour fautif.
 */
export function validateOpeningDays(days: OpeningHourDay[]): Partial<Record<DayOfWeek, string>> {
  const errors: Partial<Record<DayOfWeek, string>> = {};

  for (const day of days) {
    if (day.isClosed || day.periods.length === 0) {
      continue;
    }
    const parsed: Array<{ opens: number; closes: number }> = [];
    for (const period of day.periods) {
      const opens = toMinutes(period.opensAt);
      const closes = toMinutes(period.closesAt);
      if (opens === null || closes === null) {
        errors[day.dayOfWeek] = 'Heure invalide (format HH:mm attendu)';
        break;
      }
      if (opens >= closes) {
        errors[day.dayOfWeek] = 'L’ouverture doit précéder la fermeture (pas de plage sur minuit)';
        break;
      }
      parsed.push({ opens, closes });
    }
    if (errors[day.dayOfWeek]) {
      continue;
    }
    parsed.sort((a, b) => a.opens - b.opens);
    for (let index = 1; index < parsed.length; index += 1) {
      if (parsed[index].opens < parsed[index - 1].closes) {
        errors[day.dayOfWeek] = 'Les plages horaires se chevauchent';
        break;
      }
    }
  }

  return errors;
}

/** Jeu complet des 7 jours à partir d'une réponse API (jours manquants = fermés). */
export function normalizeWeek(days: OpeningHourDay[]): OpeningHourDay[] {
  return WEEK_DAYS.map(
    (dayOfWeek) =>
      days.find((day) => day.dayOfWeek === dayOfWeek) ?? { dayOfWeek, isClosed: true, periods: [] },
  );
}
