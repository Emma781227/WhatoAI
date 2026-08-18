import { z } from 'zod';

import { booleanEnv } from './helpers';

/**
 * Variables IA — partagées API et worker.
 *
 * Comme pour Meta, les secrets sont OPTIONNELS : sans clé, le provider MOCK
 * fonctionne et le reste de l'application est inchangé. `GEMINI_API_KEY` ne
 * vit QUE dans `.env` (jamais `.env.example`, jamais en base, jamais dans un
 * log, un test, Swagger ou le frontend) et n'est JAMAIS préfixée
 * `NEXT_PUBLIC_`.
 *
 * `GEMINI_API_BASE_URL` est configurable (décision D4 validée) pour pointer
 * les tests vers un faux serveur Gemini local : le VRAI provider est alors
 * exercé (URL, en-têtes, payload, timeout, mapping d'erreurs) sans appeler
 * Google — la stratégie qui a fait ses preuves sur le faux serveur Graph.
 */
export const aiEnvFields = {
  AI_PROVIDER: z.enum(['MOCK', 'GEMINI']).default('MOCK'),

  /**
   * Coupe-circuit GLOBAL. Ordre de priorité validé : `DISABLED` ici désactive
   * l'IA partout, quelle que soit la configuration par Shop ; sinon
   * `AiConfiguration.mode` fait autorité ; sinon cette valeur sert de défaut.
   */
  AI_MODE: z.enum(['DISABLED', 'SUGGEST_ONLY', 'AUTO_REPLY']).default('SUGGEST_ONLY'),

  GEMINI_API_KEY: z.string().optional(),
  /**
   * Aucun nom de modèle en dur nulle part (exigence explicite) : le modèle
   * vient TOUJOURS de cette variable, ou de `AiConfiguration.model`.
   */
  GEMINI_MODEL: z.string().optional(),
  GEMINI_API_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com'),
  /**
   * Version d'API Graph Gemini — explicite, jamais codée en dur dans le
   * provider. `v1beta` porte generateContent + responseSchema + function
   * calling. L'URL est construite de façon centralisée dans le provider.
   */
  GEMINI_API_VERSION: z.string().default('v1beta'),

  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(300),
  AI_CONTEXT_MAX_MESSAGES: z.coerce.number().int().positive().default(50),
  /**
   * Budget d'ENTRÉE du contexte, en tokens ESTIMÉS (CI-G1). Un plafond en
   * nombre de messages ne borne pas le coût : 50 messages courts et 50 messages
   * longs n'ont rien à voir. Le ContextBuilder assemble des blocs priorisés et
   * tronque le moins prioritaire (l'historique brut, du plus ancien au plus
   * récent) — jamais silencieusement. L'estimation est locale et déterministe
   * (aucun appel réseau) : la marge est assumée, ce budget n'est pas une limite
   * technique du modèle mais un levier de COÛT.
   */
  AI_CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(3000),
  /**
   * Résumé roulant de conversation (CI-G2). Le résumé est un APPEL FACTURÉ :
   * il ne se déclenche que sur les conversations réellement longues
   * (`AI_SUMMARY_MIN_MESSAGES`) et n'est régénéré que tous les
   * `AI_SUMMARY_REFRESH_EVERY_MESSAGES` nouveaux messages — sinon le résumé
   * existant est réutilisé tel quel. Mettre `AI_SUMMARY_ENABLED=false` coupe
   * complètement la fonctionnalité (aucun appel, aucun coût).
   */
  AI_SUMMARY_ENABLED: booleanEnv(true),
  AI_SUMMARY_MIN_MESSAGES: z.coerce.number().int().positive().default(20),
  AI_SUMMARY_REFRESH_EVERY_MESSAGES: z.coerce.number().int().positive().default(10),
  /** Messages transmis au résumeur quand AUCUN résumé n'existe encore. */
  AI_SUMMARY_MAX_INPUT_MESSAGES: z.coerce.number().int().positive().default(40),
  AI_SUMMARY_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(250),

  AI_TOOL_MAX_ROUNDS: z.coerce.number().int().positive().default(4),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),

  /**
   * Fenêtre de regroupement (D3 validée) : plusieurs messages clients
   * rapprochés produisent UN seul run, portant le dernier message comme
   * déclencheur. Ne doit pas retarder excessivement la réponse.
   */
  AI_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(3000),
} as const;
