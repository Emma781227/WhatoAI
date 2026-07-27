import { apiErrorFromResponse, ApiError, NETWORK_ERROR_CODE } from './api-error';
import { getAccessToken } from './token-store';
import { env } from '@/lib/env';

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Désactive le cycle 401 → refresh → retry (utilisé par les routes auth elles-mêmes). */
  skipAuthRetry?: boolean;
}

/**
 * Handler de 401 branché par la couche auth (lib/auth/refresh-coordinator).
 * Retourne true si un nouveau token est disponible et que la requête peut
 * être rejouée. Injection tardive pour éviter un cycle d'imports.
 */
let unauthorizedHandler: (() => Promise<boolean>) | null = null;

export function setUnauthorizedHandler(handler: (() => Promise<boolean>) | null): void {
  unauthorizedHandler = handler;
}

async function performFetch(path: string, options: ApiRequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    // env.NEXT_PUBLIC_API_URL contient déjà /api — jamais ajouté ici.
    return await fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiError({
      status: 0,
      code: NETWORK_ERROR_CODE,
      message: 'Network request failed',
    });
  }
}

/**
 * Requête API typée : Bearer automatique, credentials include, erreurs
 * normalisées en ApiError. Sur 401 : une tentative de refresh coordonnée
 * (single-flight, inter-onglets) puis UN seul replay de la requête.
 * Aucun token n'apparaît dans les logs ou les messages d'erreur.
 */
export async function apiRequest<TResponse>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<TResponse> {
  let response = await performFetch(path, options);

  if (response.status === 401 && !options.skipAuthRetry && unauthorizedHandler) {
    const refreshed = await unauthorizedHandler();
    if (refreshed) {
      response = await performFetch(path, options);
    }
  }

  if (!response.ok) {
    throw await apiErrorFromResponse(response);
  }
  if (response.status === 204) {
    return undefined as TResponse;
  }
  return (await response.json()) as TResponse;
}
