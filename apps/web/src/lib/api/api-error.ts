/**
 * Erreur API normalisée. `code` est la source principale de comportement
 * (jamais le message). Les messages techniques des 5xx ne sont JAMAIS
 * affichés : getErrorMessage les remplace par un texte public contrôlé.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(input: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  }) {
    super(input.message);
    this.name = 'ApiError';
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
    this.requestId = input.requestId;
  }
}

export const NETWORK_ERROR_CODE = 'NETWORK_ERROR';
export const UNKNOWN_ERROR_CODE = 'UNKNOWN_ERROR';

/** Corps d'erreur du backend : { statusCode, code, message } (DomainErrorFilter). */
export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Corps vide ou non-JSON : on garde les valeurs par défaut.
  }
  const rawMessage = body.message;
  return new ApiError({
    status: response.status,
    code: typeof body.code === 'string' ? body.code : UNKNOWN_ERROR_CODE,
    message: Array.isArray(rawMessage)
      ? rawMessage.join(' ')
      : typeof rawMessage === 'string'
        ? rawMessage
        : `Erreur ${response.status}`,
    details: body.details,
    requestId:
      typeof body.requestId === 'string'
        ? body.requestId
        : (response.headers.get('x-request-id') ?? undefined),
  });
}

/**
 * Message affichable à l'utilisateur. Les 4xx portent des messages métier
 * contrôlés par le backend → affichés tels quels. Les 5xx et erreurs réseau
 * reçoivent un message public générique (avec requestId pour le support).
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status >= 500 || error.code === UNKNOWN_ERROR_CODE) {
      const reference = error.requestId ? ` (réf. ${error.requestId})` : '';
      return `Une erreur inattendue est survenue. Réessayez plus tard.${reference}`;
    }
    if (error.code === NETWORK_ERROR_CODE) {
      return 'Impossible de joindre le serveur. Vérifiez votre connexion.';
    }
    return error.message;
  }
  return 'Une erreur inattendue est survenue. Réessayez plus tard.';
}
