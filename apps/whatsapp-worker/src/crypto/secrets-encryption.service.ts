import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildKeyring, decryptSecret, encryptSecret, type Keyring } from '@whauto/crypto';
import { DomainError } from '@whauto/shared';

/** 500 : chiffrement sollicité sans clé maître configurée (dernier rempart). */
export class SecretsEncryptionNotConfiguredError extends DomainError {
  constructor() {
    super('Secrets encryption is not configured.', 'SECRETS_ENCRYPTION_NOT_CONFIGURED', 500);
    this.name = 'SecretsEncryptionNotConfiguredError';
  }
}

/**
 * Chiffrement/déchiffrement des secrets au repos côté WORKER (déchiffre les
 * tokens Meta pour envoyer des messages). Fine couche Nest au-dessus du package
 * PUR `@whauto/crypto` — miroir du service API, sur les MÊMES primitives. La clé
 * maître vient uniquement de l'environnement, jamais de la base ni des logs.
 */
@Injectable()
export class SecretsEncryptionService {
  private readonly keyring: Keyring | null;

  constructor(config: ConfigService) {
    const activeKeyBase64 = config.get<string>('SECRETS_ENCRYPTION_KEY');
    if (!activeKeyBase64) {
      this.keyring = null;
      return;
    }
    const previousRaw = config.get<string>('SECRETS_ENCRYPTION_KEYS_PREVIOUS');
    const previousKeysBase64 = previousRaw ? (JSON.parse(previousRaw) as string[]) : undefined;
    this.keyring = buildKeyring({ activeKeyBase64, previousKeysBase64 });
  }

  isConfigured(): boolean {
    return this.keyring !== null;
  }

  encrypt(plaintext: string): string {
    if (!this.keyring) {
      throw new SecretsEncryptionNotConfiguredError();
    }
    return encryptSecret(plaintext, this.keyring);
  }

  decrypt(envelope: string): string {
    if (!this.keyring) {
      throw new SecretsEncryptionNotConfiguredError();
    }
    return decryptSecret(envelope, this.keyring);
  }
}
