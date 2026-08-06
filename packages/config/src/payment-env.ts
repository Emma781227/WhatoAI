import { z } from 'zod';

import { booleanEnv, optionalUrl } from './helpers';

/**
 * Variables de paiement (SaaS — recharge de crédits). `PAYMENT_PROVIDER=MOCK`
 * pendant les tests locaux. `ALLOW_MOCK_PAYMENTS` autorise l'endpoint de
 * confirmation MOCK — FORCÉ à false en production par le superRefine d'api-env.
 *
 * Les vrais secrets Genius Pay (futur) vivent UNIQUEMENT dans `.env` (jamais
 * `.env.example`, base, log, Swagger, test, frontend ni Socket.IO) et sont tous
 * OPTIONNELS : sans eux, le provider MOCK fonctionne.
 */
export const paymentEnvFields = {
  PAYMENT_PROVIDER: z.enum(['MOCK', 'GENIUS_PAY']).default('MOCK'),
  ALLOW_MOCK_PAYMENTS: booleanEnv(false),

  // Genius Pay — préparés, non utilisés tant que le provider n'est pas implémenté.
  // Les URLs tolèrent la chaîne vide (`FOO=` dans .env) → traitée comme absente.
  GENIUS_PAY_API_BASE_URL: optionalUrl(),
  GENIUS_PAY_API_KEY: z.string().optional(),
  GENIUS_PAY_SECRET_KEY: z.string().optional(),
  GENIUS_PAY_WEBHOOK_SECRET: z.string().optional(),
  GENIUS_PAY_MERCHANT_ID: z.string().optional(),
  GENIUS_PAY_RETURN_URL: optionalUrl(),
  GENIUS_PAY_CANCEL_URL: optionalUrl(),
  PAYMENT_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  // Reconciliation (D3) : rattrape les webhooks perdus en sondant les TopUp
  // PENDING/PROCESSING via getPaymentStatus, et rejoue les événements durable
  // inbox coincés. Le crédit passe TOUJOURS par creditTopUp (idempotent).
  PAYMENT_RECONCILIATION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(120000),
  // Âge minimum avant de sonder un TopUp (laisse le webhook arriver d'abord).
  PAYMENT_RECONCILIATION_MIN_AGE_MS: z.coerce.number().int().positive().default(60000),
  // Au-delà : un TopUp jamais finalisé est abandonné (EXPIRED) pour ne pas sonder indéfiniment.
  PAYMENT_RECONCILIATION_MAX_AGE_MS: z.coerce.number().int().positive().default(86400000),
} as const;
