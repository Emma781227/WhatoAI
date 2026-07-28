import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MockPaymentProvider,
  PaymentProviderConfigurationError,
  type PaymentProvider,
  type PaymentProviderName,
} from '@whauto/payments';

/**
 * Fournit le `PaymentProvider` selon `PAYMENT_PROVIDER`. En MOCK : provider
 * factice. `GENIUS_PAY` n'est pas encore implémenté (groupe futur) → erreur de
 * configuration explicite. `WalletService`/`TopUpService` ne connaissent que le
 * contrat, jamais un provider concret.
 */
@Injectable()
export class PaymentProviderFactory {
  private readonly provider: PaymentProvider;

  constructor(private readonly config: ConfigService) {
    const name = this.config.get<PaymentProviderName>('PAYMENT_PROVIDER') ?? 'MOCK';
    if (name === 'MOCK') {
      this.provider = new MockPaymentProvider();
    } else {
      // Genius Pay : contrat prêt, implémentation reportée à un groupe dédié.
      throw new PaymentProviderConfigurationError();
    }
  }

  get(): PaymentProvider {
    return this.provider;
  }

  /** L'endpoint de confirmation MOCK n'est autorisé que si le flag l'active. */
  allowMockPayments(): boolean {
    return this.provider.getProviderName() === 'MOCK' && this.config.get('ALLOW_MOCK_PAYMENTS') === true;
  }
}
