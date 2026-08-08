/**
 * Erreurs du chiffrement des secrets — PURES (aucune dépendance : la couche Nest
 * les mappe si besoin). Aucun message ne contient jamais de clé ni de secret en
 * clair.
 */
export class SecretsCryptoError extends Error {
  constructor(message = 'Secrets crypto error.') {
    super(message);
    this.name = 'SecretsCryptoError';
  }
}

/** La clé indiquée par l'enveloppe (`keyId`) n'est pas dans le keyring courant. */
export class SecretsKeyNotFoundError extends SecretsCryptoError {
  constructor(keyId: string) {
    super(`No encryption key available for key id "${keyId}".`);
    this.name = 'SecretsKeyNotFoundError';
  }
}

/** Déchiffrement échoué : tag d'authentification invalide (donnée altérée/mauvaise clé). */
export class SecretsDecryptError extends SecretsCryptoError {
  constructor() {
    super('Secret decryption failed (authentication tag mismatch).');
    this.name = 'SecretsDecryptError';
  }
}

/** Enveloppe mal formée (version/format inattendu). */
export class SecretsEnvelopeError extends SecretsCryptoError {
  constructor() {
    super('Invalid secret envelope format.');
    this.name = 'SecretsEnvelopeError';
  }
}
