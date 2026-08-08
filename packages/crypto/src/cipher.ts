import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { SecretsDecryptError, SecretsEnvelopeError, SecretsKeyNotFoundError } from './errors';
import type { Keyring } from './keyring';

/**
 * Chiffrement authentifié AES-256-GCM des secrets au repos. Enveloppe VERSIONNÉE
 * et auto-descriptive :
 *   `v1.<keyId>.<iv_b64>.<tag_b64>.<ciphertext_b64>`
 * - `v1` : version du schéma (évolutions futures sans casser l'existant) ;
 * - `keyId` : quelle clé a chiffré (support de la ROTATION via le keyring) ;
 * - `iv` : nonce aléatoire de 12 octets (jamais réutilisé) ;
 * - `tag` : tag GCM (intégrité + authenticité — toute altération est détectée).
 * Le résultat est du texte ASCII stockable tel quel en base (colonnes `*Encrypted`).
 */
const VERSION = 'v1';
const IV_BYTES = 12;

export function encryptSecret(plaintext: string, keyring: Keyring): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyring.active.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    keyring.active.id,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export function decryptSecret(envelope: string, keyring: Keyring): string {
  const parts = envelope.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new SecretsEnvelopeError();
  }
  const [, keyId, ivB64, tagB64, ciphertextB64] = parts;
  const cryptoKey = keyring.all.get(keyId);
  if (!cryptoKey) {
    throw new SecretsKeyNotFoundError(keyId);
  }
  const decipher = createDecipheriv('aes-256-gcm', cryptoKey.key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    // Tag GCM invalide : donnée altérée ou mauvaise clé — jamais de détail fuité.
    throw new SecretsDecryptError();
  }
}

/** Extrait le `keyId` d'une enveloppe sans déchiffrer (diagnostic/rotation). */
export function envelopeKeyId(envelope: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new SecretsEnvelopeError();
  }
  return parts[1];
}
