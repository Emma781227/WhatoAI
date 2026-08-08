import { createHash } from 'node:crypto';

import { SecretsCryptoError } from './errors';

/** Une clé de chiffrement AES-256 (32 octets) + son identifiant déterministe. */
export interface CryptoKey {
  id: string;
  key: Buffer;
}

/**
 * Trousseau de clés. `active` chiffre les nouvelles données ; `all` (indexé par
 * `id`) permet de DÉCHIFFRER des données produites par une clé précédente pendant
 * une rotation. La clé maître ne vit JAMAIS en base — elle est fournie par
 * l'environnement (ou un KMS futur derrière la même interface).
 */
export interface Keyring {
  active: CryptoKey;
  all: ReadonlyMap<string, CryptoKey>;
}

const KEY_BYTES = 32;

/**
 * Identifiant déterministe et NON secret d'une clé : préfixe du SHA-256 de la
 * clé. Il n'expose pas la clé (fonction à sens unique) et permet de retrouver la
 * bonne clé de déchiffrement dans le keyring, y compris après rotation.
 */
export function deriveKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function toCryptoKey(base64Key: string): CryptoKey {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new SecretsCryptoError(`Encryption key must be ${KEY_BYTES} bytes (base64-encoded).`);
  }
  return { id: deriveKeyId(key), key };
}

/**
 * Construit un keyring depuis une clé active + d'éventuelles clés précédentes
 * (rotation). Toutes en base64. La clé active est aussi présente dans `all`.
 */
export function buildKeyring(input: {
  activeKeyBase64: string;
  previousKeysBase64?: readonly string[];
}): Keyring {
  const active = toCryptoKey(input.activeKeyBase64);
  const all = new Map<string, CryptoKey>();
  all.set(active.id, active);
  for (const previous of input.previousKeysBase64 ?? []) {
    const k = toCryptoKey(previous);
    if (!all.has(k.id)) {
      all.set(k.id, k);
    }
  }
  return { active, all };
}
