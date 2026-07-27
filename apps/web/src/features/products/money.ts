/**
 * Formatage des montants en unité MINEURE entière (XAF 5000 = 5 000 XAF ;
 * EUR 1299 = 12,99 €). Le nombre de décimales vient d'Intl (XAF → 0, EUR → 2)
 * — jamais de flottant côté stockage, la division n'existe qu'à l'affichage.
 */
export function minorUnitDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export function formatMinorAmount(minor: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  const major = minor / 10 ** digits;
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits > 0 ? digits : 0,
    }).format(major);
  } catch {
    return `${major} ${currency}`;
  }
}

/** Fourchette compacte : "5 000 FCFA" ou "5 000 – 8 000 FCFA". */
export function formatMinorRange(
  min: number | null,
  max: number | null,
  currency: string,
): string {
  if (min === null) {
    return '—';
  }
  if (max === null || max === min) {
    return formatMinorAmount(min, currency);
  }
  return `${formatMinorAmount(min, currency)} – ${formatMinorAmount(max, currency)}`;
}

/** Saisie utilisateur (unité MAJEURE, ex. "12,99") → unité mineure entière, null si invalide. */
export function parseMajorToMinor(input: string, currency: string): number | null {
  const normalized = input.trim().replace(/\s/g, '').replace(',', '.');
  if (normalized === '' || !/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }
  const digits = minorUnitDigits(currency);
  const minor = Math.round(Number(normalized) * 10 ** digits);
  return Number.isSafeInteger(minor) && minor >= 0 && minor <= 2_147_483_647 ? minor : null;
}

/** Unité mineure → chaîne de saisie en unité majeure ("1299" → "12.99"). */
export function minorToMajorInput(minor: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  return (minor / 10 ** digits).toFixed(digits);
}
