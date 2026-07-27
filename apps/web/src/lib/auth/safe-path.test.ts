import { describe, expect, it } from 'vitest';

import { getSafeInternalPath } from './safe-path';

describe('getSafeInternalPath', () => {
  it('accepte les chemins internes', () => {
    expect(getSafeInternalPath('/shops')).toBe('/shops');
    expect(getSafeInternalPath('/invitations/accept?token=abc')).toBe('/invitations/accept?token=abc');
  });

  it('refuse les URLs absolues et externes', () => {
    expect(getSafeInternalPath('https://evil.example')).toBe('/dashboard');
    expect(getSafeInternalPath('http://evil.example/phish')).toBe('/dashboard');
    expect(getSafeInternalPath('javascript:alert(1)')).toBe('/dashboard');
  });

  it('refuse les chemins protocol-relative (//) et backslash', () => {
    expect(getSafeInternalPath('//evil.example')).toBe('/dashboard');
    expect(getSafeInternalPath('/\\evil.example')).toBe('/dashboard');
  });

  it('valeurs vides → fallback (personnalisable)', () => {
    expect(getSafeInternalPath(null)).toBe('/dashboard');
    expect(getSafeInternalPath(undefined, '/onboarding')).toBe('/onboarding');
    expect(getSafeInternalPath('')).toBe('/dashboard');
  });
});
