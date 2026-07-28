import { Module } from '@nestjs/common';

import { OrganizationsModule } from '../modules/organizations/organizations.module';
import { PaymentProviderFactory } from './payment-provider.factory';
import { TopUpService } from './topup.service';
import { WalletService } from './wallet.service';

/**
 * Module Wallet (groupes 1-2 : provisioning/lecture + crédit/recharge). Importe
 * OrganizationsModule pour `OrganizationAuditService` (audits TopUp/Wallet).
 * Aucun couplage circulaire : OrganizationsService provisionne le Wallet en
 * inline (ne dépend PAS de WalletModule). Pas d'API/realtime dans ces groupes.
 */
@Module({
  imports: [OrganizationsModule],
  providers: [WalletService, TopUpService, PaymentProviderFactory],
  exports: [WalletService, TopUpService, PaymentProviderFactory],
})
export class WalletModule {}
