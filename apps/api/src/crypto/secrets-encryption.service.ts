import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildKeyring, decryptSecret, encryptSecret, type Keyring } from '@whauto/crypto';
import { DomainError } from '@whauto/shared';

/**
 * 500 : le service de chiffrement est sollicité sans clé maître configurée.
 * Ne devrait jamais remonter au client (les fonctionnalités qui stockent des
 * secrets exigeront la clé au boot) — dernier rempart, jamais de détail fuité.
 */
export class SecretsEncryptionNotConfiguredError extends DomainError {
  constructor() {
    super('Secrets encryption is not configured.', 'SECRETS_ENCRYPTION_NOT_CONFIGURED', 500);
    this.name = 'SecretsEncryptionNotConfiguredError';
  }
}

/**
 * Chiffrement/déchiffrement des secrets au repos (tokens Meta multi-tenant à
 * venir). Fine couche Nest au-dessus du package PUR `@whauto/crypto` : charge le
 * keyring depuis l'environnement (clé active + clés précédentes pour la
 * rotation). La clé maître ne vit JAMAIS en base ni dans les logs. `isConfigured`
 * permet aux appelants de dégrader proprement quand aucune clé n'est fournie.
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

  /** Chiffre un secret en clair → enveloppe stockable en base (colonnes `*Encrypted`). */
  encrypt(plaintext: string): string {
    if (!this.keyring) {
      throw new SecretsEncryptionNotConfiguredError();
    }
    return encryptSecret(plaintext, this.keyring);
  }

  /** Déchiffre une enveloppe → secret en clair (jamais logué, jamais sérialisé). */
  decrypt(envelope: string): string {
    if (!this.keyring) {
      throw new SecretsEncryptionNotConfiguredError();
    }
    return decryptSecret(envelope, this.keyring);
  }
}
