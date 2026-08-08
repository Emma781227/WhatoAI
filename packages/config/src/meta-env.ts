import { z } from 'zod';

import { booleanEnv } from './helpers';

/**
 * Variables Meta WhatsApp Cloud API — partagées API et worker (une seule
 * configuration Meta pilote issue de l'environnement dans cette phase).
 *
 * Tous les secrets sont OPTIONNELS : Meta peut ne pas être configuré (le
 * provider MOCK continue de fonctionner). Chaque méthode du provider vérifie
 * la présence de ce dont elle a besoin. Les secrets ne sont JAMAIS mis en
 * base, log, Swagger, test ou frontend.
 *
 * `META_GRAPH_API_VERSION` et `META_GRAPH_API_BASE_URL` ont des valeurs par
 * défaut ; la base est configurable pour pointer les tests vers un faux
 * serveur Graph local (le vrai provider est alors exercé sans appeler Meta).
 */
export const metaEnvFields = {
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_ACCESS_TOKEN: z.string().optional(),
  META_WABA_ID: z.string().optional(),
  META_PHONE_NUMBER_ID: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default('v21.0'),
  META_GRAPH_API_BASE_URL: z.string().url().default('https://graph.facebook.com'),
  META_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // Multi-tenant Meta : chaque Organization a ses propres credentials chiffrés
  // (à la place du pilote mono-config env). Quand activé, le chiffrement des
  // secrets DOIT être configuré (fail-fast — voir superRefine api/worker-env).
  META_MULTI_TENANT_ENABLED: booleanEnv(false),
} as const;
