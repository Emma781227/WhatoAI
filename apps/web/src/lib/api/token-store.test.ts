import { afterEach, describe, expect, it } from 'vitest';

import { clearAccessToken, getAccessToken, getTokenExpiry, setAccessToken } from './token-store';

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.signature`;
}

afterEach(() => {
  clearAccessToken();
  localStorage.clear();
  sessionStorage.clear();
});

describe('token-store', () => {
  it('conserve le token en mémoire uniquement — JAMAIS dans localStorage/sessionStorage', () => {
    setAccessToken('secret-token-value');
    expect(getAccessToken()).toBe('secret-token-value');

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('secret-token-value');
  });

  it('clearAccessToken purge le token', () => {
    setAccessToken('to-clear');
    clearAccessToken();
    expect(getAccessToken()).toBeNull();
  });

  it('getTokenExpiry lit exp (secondes epoch → ms), et null si illisible', () => {
    expect(getTokenExpiry(fakeJwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
    expect(getTokenExpiry(fakeJwt({}))).toBeNull();
    expect(getTokenExpiry('not-a-jwt')).toBeNull();
    expect(getTokenExpiry('a.b')).toBeNull();
  });
});
