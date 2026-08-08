import { Global, Module } from '@nestjs/common';

import { SecretsEncryptionService } from './secrets-encryption.service';

/**
 * Chiffrement des secrets au repos, transverse (tokens Meta multi-tenant,
 * credentials providers). Global : le service est injectable partout sans import
 * répété. La clé maître provient uniquement de l'environnement.
 */
@Global()
@Module({
  providers: [SecretsEncryptionService],
  exports: [SecretsEncryptionService],
})
export class CryptoModule {}
