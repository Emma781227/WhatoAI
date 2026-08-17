import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Vérification du `signed_request` Meta (callbacks Deauthorize / Data Deletion).
 *
 * Format : `<base64url(signature)>.<base64url(payloadJson)>`. La signature est un
 * HMAC-SHA256 calculé sur la PARTIE ENCODÉE du payload (pas le JSON décodé), avec
 * l'App Secret. On recalcule et on compare en temps constant — autorité
 * cryptographique unique, à l'image du HMAC des webhooks. Aucun secret n'est logué.
 *
 * Package PUR : l'App Secret est INJECTÉ, jamais lu depuis l'environnement.
 */
export interface MetaSignedRequestPayload {
  algorithm: string;
  issued_at?: number;
  /** ID utilisateur Facebook (app-scoped) — clé de rattachement au commerçant. */
  user_id?: string;
  [key: string]: unknown;
}

/**
 * Renvoie le payload décodé si la signature est VALIDE et l'algorithme attendu,
 * sinon `null` (signature invalide/absente, format incorrect, JSON illisible).
 * Ne lève jamais : l'appelant traduit `null` en refus (401).
 */
export function parseMetaSignedRequest(
  signedRequest: string | undefined,
  appSecret: string | undefined,
): MetaSignedRequestPayload | null {
  if (typeof signedRequest !== 'string' || signedRequest.length === 0) return null;
  if (typeof appSecret !== 'string' || appSecret.length === 0) return null;

  const parts = signedRequest.split('.');
  if (parts.length !== 2) return null;
  const [encodedSig, encodedPayload] = parts;
  if (!encodedSig || !encodedPayload) return null;

  let providedSig: Buffer;
  try {
    providedSig = Buffer.from(encodedSig, 'base64url');
  } catch {
    return null;
  }
  const expectedSig = createHmac('sha256', appSecret).update(encodedPayload).digest();
  if (providedSig.length !== expectedSig.length || !timingSafeEqual(providedSig, expectedSig)) {
    return null;
  }

  try {
    const json = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as MetaSignedRequestPayload;
    if (json?.algorithm !== 'HMAC-SHA256') return null;
    return json;
  } catch {
    return null;
  }
}

/**
 * Construit un `signed_request` signé — utilisé UNIQUEMENT par les tests (Meta le
 * produit en production). Symétrique de {@link parseMetaSignedRequest}.
 */
export function buildMetaSignedRequest(payload: Record<string, unknown>, appSecret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', ...payload }), 'utf8').toString(
    'base64url',
  );
  const sig = createHmac('sha256', appSecret).update(encodedPayload).digest('base64url');
  return `${sig}.${encodedPayload}`;
}
