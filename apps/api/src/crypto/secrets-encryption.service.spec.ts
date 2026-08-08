import { randomBytes } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

import {
  SecretsEncryptionNotConfiguredError,
  SecretsEncryptionService,
} from './secrets-encryption.service';

function service(env: Record<string, string | undefined>): SecretsEncryptionService {
  return new SecretsEncryptionService({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

const KEY = randomBytes(32).toString('base64');

describe('SecretsEncryptionService', () => {
  it('configuré : round-trip et le clair n’apparaît jamais dans l’enveloppe', () => {
    const svc = service({ SECRETS_ENCRYPTION_KEY: KEY });
    expect(svc.isConfigured()).toBe(true);
    const envelope = svc.encrypt('EAAG-meta-access-token');
    expect(envelope).not.toContain('EAAG-meta-access-token');
    expect(envelope.startsWith('v1.')).toBe(true);
    expect(svc.decrypt(envelope)).toBe('EAAG-meta-access-token');
  });

  it('non configuré : isConfigured=false et encrypt/decrypt lèvent une erreur claire', () => {
    const svc = service({});
    expect(svc.isConfigured()).toBe(false);
    expect(() => svc.encrypt('x')).toThrow(SecretsEncryptionNotConfiguredError);
    expect(() => svc.decrypt('v1.a.b.c.d')).toThrow(SecretsEncryptionNotConfiguredError);
  });

  it('rotation : une clé passée en précédente déchiffre encore les anciens secrets', () => {
    const OLD = randomBytes(32).toString('base64');
    const oldEnvelope = service({ SECRETS_ENCRYPTION_KEY: OLD }).encrypt('ancien-token');
    const rotated = service({
      SECRETS_ENCRYPTION_KEY: KEY,
      SECRETS_ENCRYPTION_KEYS_PREVIOUS: JSON.stringify([OLD]),
    });
    expect(rotated.decrypt(oldEnvelope)).toBe('ancien-token');
    // Les nouveaux secrets utilisent la clé active (déchiffrables par le keyring courant).
    expect(rotated.decrypt(rotated.encrypt('nouveau'))).toBe('nouveau');
  });
});
