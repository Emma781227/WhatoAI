import { z } from 'zod';

import { aiEnvFields } from './ai-env';
import { baseEnvSchema } from './base-env';
import { cryptoEnvFields } from './crypto-env';
import { metaEnvFields } from './meta-env';

export const workerEnvSchema = baseEnvSchema.extend({
  ...metaEnvFields,
  ...aiEnvFields,
  ...cryptoEnvFields,
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // WhatsApp — jobs BullMQ (noms de queues = constantes @whauto/shared).
  WHATSAPP_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WHATSAPP_JOB_BACKOFF_MS: z.coerce.number().int().positive().default(2000),

  // Provider MOCK — délais de simulation des statuts DELIVERED puis READ
  // après un envoi réussi (courts en test, réalistes en dev).
  WHATSAPP_MOCK_DELIVERY_DELAY_MS: z.coerce.number().int().nonnegative().default(1500),
  WHATSAPP_MOCK_READ_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),

  // Récupération périodique (durable inbox + transactional outbox) : les
  // événements RECEIVED/QUEUED/FAILED et les outbox PENDING plus vieux que la
  // staleness sont republiés — reprise garantie après panne Redis/worker/API.
  WHATSAPP_RECOVERY_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  WHATSAPP_RECOVERY_STALENESS_MS: z.coerce.number().int().positive().default(60000),

  // Statut orphelin (providerMessageId encore inconnu) : au-delà de ce délai
  // en WAITING_MESSAGE, l'événement passe ORPHANED (terminal, non FAILED).
  WHATSAPP_ORPHAN_STATUS_TTL_MS: z.coerce.number().int().positive().default(300000),

  // Panier conversationnel — sweep d'expiration (réservations, paniers
  // inactifs, filet anti-orphelins, purge des mutations d'idempotence).
  CART_INACTIVITY_TTL_MINUTES: z.coerce.number().positive().default(120),
  STOCK_RESERVATION_TTL_MINUTES: z.coerce.number().positive().default(15),
  STOCK_RESERVATION_MAX_LIFETIME_MINUTES: z.coerce.number().positive().default(60),
  STOCK_RESERVATION_RENEWAL_MIN_INTERVAL_SECONDS: z.coerce.number().positive().default(60),
  CART_EXPIRATION_SWEEP_INTERVAL_SECONDS: z.coerce.number().positive().default(30),

  // IA — sweep de récupération : republie un message éligible resté sans AiRun
  // (commit inbound réussi mais publication du job de debounce perdue —
  // ex. Redis indisponible, ou race de remplacement du job différé).
  AI_RECOVERY_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  // FENÊTRE MAXIMALE bornée (ajustement 11) : ne jamais réveiller l'IA sur un
  // vieux message. Un inbound plus ancien que cet âge n'est jamais rattrapé.
  AI_RECOVERY_MAX_MESSAGE_AGE_MS: z.coerce.number().int().positive().default(600000),
  // Âge minimum avant sweep : laisse passer la fenêtre de debounce + une marge,
  // pour ne pas doubler le chemin normal ni traiter un message encore « chaud ».
  AI_RECOVERY_MIN_MESSAGE_AGE_MS: z.coerce.number().int().positive().default(15000),

  // Billing IA — sweep comptable des réservations (groupe 5) : réconcilie toute
  // réservation RESERVED dont le run est déjà TERMINAL (ex. run passé FAILED en
  // masse par le sweep de récupération) en libérant les crédits. Filet de
  // sécurité de l'invariant « aucune réservation active pour un run terminé ».
  AI_RESERVATION_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function parseWorkerEnv(raw: Record<string, string | undefined>): WorkerEnv {
  return workerEnvSchema.parse(raw);
}
