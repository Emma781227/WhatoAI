import { z } from 'zod';

import { aiEnvFields } from './ai-env';
import { baseEnvSchema } from './base-env';
import { cryptoEnvFields } from './crypto-env';
import { booleanEnv } from './helpers';
import { metaEnvFields } from './meta-env';
import { paymentEnvFields } from './payment-env';

export const apiEnvSchema = baseEnvSchema.extend({
  ...metaEnvFields,
  ...aiEnvFields,
  ...paymentEnvFields,
  ...cryptoEnvFields,
  API_PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Auth — JWT (access token uniquement, le refresh token est opaque)
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  // 7 jours — règle de sécurité CLAUDE.md (rotation à chaque refresh).
  REFRESH_TOKEN_EXPIRES_IN_DAYS: z.coerce.number().int().positive().default(7),

  // Auth — cookie du refresh token
  COOKIE_NAME: z.string().default('whauto_refresh'),
  // Pas de valeur par défaut : cookie host-only sauf besoin réel démontré (voir CLAUDE.md).
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: booleanEnv(false),
  // Strict par défaut — règle de sécurité CLAUDE.md (cookie httpOnly + SameSite=Strict).
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('strict'),

  // Auth — liens frontend / email
  APP_WEB_URL: z.string().url().default('http://localhost:3000'),
  EMAIL_PROVIDER: z.enum(['console']).default('console'),
  EMAIL_FROM: z.string().default('noreply@whauto.ai'),
  PASSWORD_RESET_EXPIRES_IN_MINUTES: z.coerce.number().int().positive().default(30),
  EMAIL_VERIFICATION_EXPIRES_IN_HOURS: z.coerce.number().int().positive().default(24),

  // Organizations — invitations
  INVITATION_EXPIRES_IN_DAYS: z.coerce.number().int().positive().default(7),

  // Auth — dev uniquement : expose les liens de vérification/reset dans la réponse HTTP
  // au lieu de devoir lire les logs serveur. Jamais actif en dehors de development.
  AUTH_EXPOSE_TEST_TOKENS: booleanEnv(false),

  // Auth — rate limiting (MAX requêtes par fenêtre de WINDOW_SECONDS)
  AUTH_RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(5),
  AUTH_RATE_LIMIT_LOGIN_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  AUTH_RATE_LIMIT_REGISTER_MAX: z.coerce.number().int().positive().default(3),
  AUTH_RATE_LIMIT_REGISTER_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  AUTH_RATE_LIMIT_RESET_MAX: z.coerce.number().int().positive().default(3),
  AUTH_RATE_LIMIT_RESET_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  AUTH_RATE_LIMIT_REFRESH_MAX: z.coerce.number().int().positive().default(20),
  AUTH_RATE_LIMIT_REFRESH_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  AUTH_RATE_LIMIT_FORGOT_PASSWORD_MAX: z.coerce.number().int().positive().default(3),
  AUTH_RATE_LIMIT_FORGOT_PASSWORD_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  AUTH_RATE_LIMIT_RESEND_VERIFICATION_MAX: z.coerce.number().int().positive().default(3),
  AUTH_RATE_LIMIT_RESEND_VERIFICATION_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60),

  // WhatsApp — endpoints de simulation mock (POST /api/dev/whatsapp/mock/*).
  // FORCÉ à false en production par le superRefine ci-dessous : le module
  // n'est alors même pas enregistré (routes physiquement absentes).
  ENABLE_MOCK_WHATSAPP_ENDPOINTS: booleanEnv(false),

  // WhatsApp — jobs BullMQ (les NOMS de queues sont des constantes
  // @whauto/shared, jamais des variables d'environnement).
  WHATSAPP_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WHATSAPP_JOB_BACKOFF_MS: z.coerce.number().int().positive().default(2000),

  // Panier conversationnel — TTLs (valeurs courtes uniquement en test).
  CART_INACTIVITY_TTL_MINUTES: z.coerce.number().positive().default(120),
  STOCK_RESERVATION_TTL_MINUTES: z.coerce.number().positive().default(15),
  STOCK_RESERVATION_MAX_LIFETIME_MINUTES: z.coerce.number().positive().default(60),
  STOCK_RESERVATION_RENEWAL_MIN_INTERVAL_SECONDS: z.coerce.number().positive().default(60),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.ENABLE_MOCK_WHATSAPP_ENDPOINTS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ENABLE_MOCK_WHATSAPP_ENDPOINTS'],
      message: 'ENABLE_MOCK_WHATSAPP_ENDPOINTS ne doit jamais être actif en production.',
    });
  }
  if (env.NODE_ENV === 'production' && env.ALLOW_MOCK_PAYMENTS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ALLOW_MOCK_PAYMENTS'],
      message: 'ALLOW_MOCK_PAYMENTS ne doit jamais être actif en production.',
    });
  }
  // Fail-fast Genius Pay (D6) : n'exige QUE les variables réellement nécessaires
  // selon la doc officielle — auth marchand (clé publique/secrète) + secret
  // webhook dédié. La valeur n'est JAMAIS affichée (seul le nom apparaît).
  if (env.PAYMENT_PROVIDER === 'GENIUS_PAY') {
    const required = ['GENIUS_PAY_API_KEY', 'GENIUS_PAY_SECRET_KEY', 'GENIUS_PAY_WEBHOOK_SECRET'] as const;
    for (const key of required) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} est requis quand PAYMENT_PROVIDER=GENIUS_PAY.`,
        });
      }
    }
  }
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function parseApiEnv(raw: Record<string, string | undefined>): ApiEnv {
  return apiEnvSchema.parse(raw);
}
