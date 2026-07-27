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
