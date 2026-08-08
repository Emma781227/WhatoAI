import { Module } from '@nestjs/common';

import { MetaCredentialsService } from './meta-credentials.service';

/**
 * Persistance des credentials Meta multi-tenant. `SecretsEncryptionService`
 * (CryptoModule global) et `PrismaService` (global) sont injectés. Exporté pour
 * l'Embedded Signup et la résolution du provider (groupes suivants).
 */
@Module({
  providers: [MetaCredentialsService],
  exports: [MetaCredentialsService],
})
export class MetaCredentialsModule {}
