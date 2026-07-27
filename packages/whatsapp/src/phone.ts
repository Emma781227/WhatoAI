import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Normalise un numéro vers le format E.164 canonique (`+2376XXXXXXXX`).
 * Retourne null si le numéro est invalide. Le préfixe international `+` est
 * requis : sans indicatif pays, un numéro local est ambigu — on refuse de
 * deviner (WhatsApp fournit toujours des identifiants internationaux).
 */
export function normalizePhoneNumber(raw: string): string | null {
  const trimmed = raw.trim();
  // WhatsApp (wa_id) omet parfois le "+" : un numéro entièrement numérique
  // d'au moins 8 chiffres est traité comme international sans préfixe.
  const candidate =
    trimmed.startsWith('+') ? trimmed : /^\d{8,15}$/.test(trimmed) ? `+${trimmed}` : trimmed;

  if (!candidate.startsWith('+')) {
    return null;
  }
  const parsed = parsePhoneNumberFromString(candidate);
  return parsed?.isValid() ? parsed.number : null;
}
