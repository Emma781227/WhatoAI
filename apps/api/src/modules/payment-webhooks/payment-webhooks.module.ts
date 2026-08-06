import { Module } from '@nestjs/common';

import { WalletModule } from '../../wallet/wallet.module';
import { GeniusPayWebhookController } from './genius-pay-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';

/**
 * Webhooks de PAIEMENT PUBLICS (aucun guard tenant). Importe WalletModule pour
 * `PaymentProviderFactory` (le provider vérifie la signature — autorité unique).
 * Le crédit du Wallet passe par `creditTopUp` existant (groupe suivant) : aucune
 * logique comptable ici.
 */
@Module({
  imports: [WalletModule],
  controllers: [GeniusPayWebhookController],
  providers: [PaymentWebhookService],
})
export class PaymentWebhooksModule {}
