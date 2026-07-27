/**
 * Erreurs provider IA. Volontairement SÉPARÉES des erreurs Meta (exigence du
 * cahier des charges : « ne mélange pas les erreurs Meta et Gemini ») — un
 * quota Gemini ne doit jamais être confondu avec un rejet WhatsApp.
 */

/**
 * Classification d'un échec IA — pilote la décision du worker.
 * - RETRYABLE : transitoire (5xx, timeout, indisponibilité) → nouvelle tentative ;
 * - NON_RETRYABLE : définitif (requête invalide, modèle inconnu) → AiRun FAILED ;
 * - CONFIGURATION_ERROR : clé absente/invalide → FAILED + alerte configuration ;
 * - QUOTA_ERROR : quota ou rate limit → FAILED, distinct d'une panne réelle ;
 * - INVALID_OUTPUT : réponse illisible ou non conforme au schéma structuré.
 */
export type AiErrorClass =
  | 'RETRYABLE'
  | 'NON_RETRYABLE'
  | 'CONFIGURATION_ERROR'
  | 'QUOTA_ERROR'
  | 'INVALID_OUTPUT';

/**
 * Échec d'un appel provider. Le message ne contient JAMAIS la clé API ni le
 * prompt système complet — il est destiné aux logs et au diagnostic agent.
 */
export class AiProviderError extends Error {
  public readonly code: string;
  public readonly errorClass: AiErrorClass;

  constructor(message: string, code: string, errorClass: AiErrorClass = 'RETRYABLE') {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    this.errorClass = errorClass;
  }
}

/** L'échec justifie-t-il une nouvelle tentative BullMQ ? */
export function isRetryableAiError(error: unknown): boolean {
  return error instanceof AiProviderError && error.errorClass === 'RETRYABLE';
}
