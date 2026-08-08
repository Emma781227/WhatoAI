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
  // App Meta (public, non secret) pour l'Embedded Signup côté navigateur. Vides
  // tant que l'App Meta n'est pas configurée → le bouton « Connecter mon
  // WhatsApp Business » reste masqué (aucun faux flux). Le SECRET d'App ne vit
  // JAMAIS côté frontend (échange OAuth uniquement côté serveur).
  NEXT_PUBLIC_META_APP_ID: z.string().optional(),
  NEXT_PUBLIC_META_CONFIG_ID: z.string().optional(),
});

export const env = envSchema.parse({
  // Accès statique obligatoire : Next.js inline les NEXT_PUBLIC_* au build.
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_META_APP_ID: process.env.NEXT_PUBLIC_META_APP_ID,
  NEXT_PUBLIC_META_CONFIG_ID: process.env.NEXT_PUBLIC_META_CONFIG_ID,
});

/** L'Embedded Signup Meta est-il configurable côté navigateur ? (App ID + config). */
export const isMetaEmbeddedSignupConfigured = Boolean(
  env.NEXT_PUBLIC_META_APP_ID && env.NEXT_PUBLIC_META_CONFIG_ID,
);
