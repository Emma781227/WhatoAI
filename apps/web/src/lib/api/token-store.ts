/**
 * Access token conservé EN MÉMOIRE UNIQUEMENT (variable de module).
 * Jamais dans localStorage/sessionStorage/cookie lisible — c'est testé.
 * `exp` est décodé du JWT uniquement pour planifier le refresh préventif,
 * jamais comme source de permissions ou d'identité.
 */

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function clearAccessToken(): void {
  accessToken = null;
}

/** Timestamp d'expiration (ms epoch) lu du claim `exp`, ou null si illisible. */
export function getTokenExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
