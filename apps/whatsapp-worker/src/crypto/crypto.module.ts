import { Global, Module } from '@nestjs/common';

import { SecretsEncryptionService } from './secrets-encryption.service';

/**
 * Chiffrement des secrets au repos côté worker (déchiffrement des tokens Meta
 * pour les envois). Global : injectable partout. Clé maître depuis l'environnement.
 */
@Global()
@Module({
  providers: [SecretsEncryptionService],
  exports: [SecretsEncryptionService],
})
export class CryptoModule {}
