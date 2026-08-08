import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildKeyring,
  decryptSecret,
  deriveKeyId,
  encryptSecret,
  envelopeKeyId,
  SecretsCryptoError,
  SecretsDecryptError,
  SecretsEnvelopeError,
  SecretsKeyNotFoundError,
} from './index';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');
const ringA = buildKeyring({ activeKeyBase64: KEY_A });
const ringB = buildKeyring({ activeKeyBase64: KEY_B });

describe('AES-256-GCM — chiffrement des secrets au repos', () => {
  it('round-trip : déchiffrer redonne le clair exact', () => {
    const secret = 'EAAG...meta-access-token-très-long';
    const envelope = encryptSecret(secret, ringA);
    expect(decryptSecret(envelope, ringA)).toBe(secret);
  });

  it('enveloppe versionnée v1.<keyId>.<iv>.<tag>.<ct> ; keyId = clé active', () => {
    const envelope = encryptSecret('x', ringA);
    const parts = envelope.split('.');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toBe(ringA.active.id);
    expect(envelopeKeyId(envelope)).toBe(ringA.active.id);
  });

  it('IV aléatoire : deux chiffrements du même clair donnent des enveloppes différentes', () => {
    expect(encryptSecret('same', ringA)).not.toBe(encryptSecret('same', ringA));
  });

  it('donnée ALTÉRÉE (ciphertext modifié) → SecretsDecryptError', () => {
    const envelope = encryptSecret('secret', ringA);
    const parts = envelope.split('.');
    const ct = Buffer.from(parts[4], 'base64');
    ct[0] ^= 0x01; // flip un bit
    parts[4] = ct.toString('base64');
    expect(() => decryptSecret(parts.join('.'), ringA)).toThrow(SecretsDecryptError);
  });

  it('MAUVAISE clé (même keyId absent) → SecretsKeyNotFoundError', () => {
    const envelope = encryptSecret('secret', ringA);
    expect(() => decryptSecret(envelope, ringB)).toThrow(SecretsKeyNotFoundError);
  });

  it('même keyId mais clé fournie erronée serait rejeté par le tag (défense en profondeur)', () => {
    // Enveloppe chiffrée par A, mais on construit un keyring qui prétend contenir
    // la clé de keyId(A) alors qu'il s'agit de B → le tag GCM échoue.
    const envelope = encryptSecret('secret', ringA);
    const spoofed = {
      active: ringB.active,
      all: new Map([[ringA.active.id, ringB.active]]),
    };
    expect(() => decryptSecret(envelope, spoofed)).toThrow(SecretsDecryptError);
  });

  it('enveloppe mal formée → SecretsEnvelopeError', () => {
    expect(() => decryptSecret('not-an-envelope', ringA)).toThrow(SecretsEnvelopeError);
    expect(() => decryptSecret('v2.a.b.c.d', ringA)).toThrow(SecretsEnvelopeError);
  });

  it('ROTATION : une clé devenue "précédente" déchiffre encore ; les nouveaux secrets utilisent l\'active', () => {
    const oldEnvelope = encryptSecret('ancien-secret', ringA);
    // Rotation : B devient active, A conservée en précédente.
    const rotated = buildKeyring({ activeKeyBase64: KEY_B, previousKeysBase64: [KEY_A] });
    expect(decryptSecret(oldEnvelope, rotated)).toBe('ancien-secret'); // ancienne donnée OK
    const newEnvelope = encryptSecret('nouveau-secret', rotated);
    expect(envelopeKeyId(newEnvelope)).toBe(ringB.active.id); // chiffré avec l'active (B)
    expect(decryptSecret(newEnvelope, rotated)).toBe('nouveau-secret');
  });

  it('clé de mauvaise longueur → SecretsCryptoError (jamais un chiffrement faible silencieux)', () => {
    expect(() => buildKeyring({ activeKeyBase64: Buffer.alloc(16).toString('base64') })).toThrow(
      SecretsCryptoError,
    );
  });

  it('deriveKeyId est déterministe et ne révèle pas la clé', () => {
    const key = randomBytes(32);
    expect(deriveKeyId(key)).toBe(deriveKeyId(key));
    expect(deriveKeyId(key)).not.toContain(key.toString('base64'));
  });

  it('gère le clair vide et un clair volumineux', () => {
    expect(decryptSecret(encryptSecret('', ringA), ringA)).toBe('');
    const big = 'x'.repeat(100_000);
    expect(decryptSecret(encryptSecret(big, ringA), ringA)).toBe(big);
  });
});
