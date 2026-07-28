import { z } from 'zod';

/**
 * z.coerce.boolean() treats any non-empty string as true (including "false"),
 * which silently misparses env vars. This only accepts the literal strings
 * "true"/"false".
 */
export function booleanEnv(defaultValue: boolean) {
  return z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => value === 'true');
}

/**
 * URL OPTIONNELLE tolérant la chaîne VIDE : dans un `.env`, `FOO=` produit `""`,
 * que `z.string().url().optional()` REFUSE (optional ne saute que `undefined`).
 * On transforme `""` en `undefined` AVANT la validation d'URL.
 */
export function optionalUrl() {
  return z.preprocess((value) => (value === '' ? undefined : value), z.string().url().optional());
}
