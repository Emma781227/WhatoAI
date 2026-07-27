import { z } from 'zod';

/**
 * NEXT_PUBLIC_API_URL doit contenir l'URL COMPLÈTE de l'API, /api inclus
 * (ex. http://localhost:4000/api). Le client ne rajoute jamais /api lui-même.
 * Validée au premier import — une valeur invalide fait échouer le démarrage.
 */
const envSchema = z.object({
  NEXT_PUBLIC_API_URL: z
    .string()
    .url()
    .refine((value) => value.endsWith('/api'), {
      message: 'NEXT_PUBLIC_API_URL doit se terminer par /api (ex. http://localhost:4000/api)',
    })
    .transform((value) => value.replace(/\/$/, '')),
});

export const env = envSchema.parse({
  // Accès statique obligatoire : Next.js inline les NEXT_PUBLIC_* au build.
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});
