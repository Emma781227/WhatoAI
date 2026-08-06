import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GeniusPayProvider,
  MockPaymentProvider,
  PaymentProviderConfigurationError,
  type PaymentProvider,
  type PaymentProviderName,
} from '@whauto/payments';

/** Base API officielle Genius Pay (l'environnement sandbox/live dérive du préfixe de clé). */
const GENIUS_PAY_DEFAULT_BASE_URL = 'https://pay.genius.ci/api/v1';

/**
 * Fournit le `PaymentProvider` selon `PAYMENT_PROVIDER`. MOCK : provider factice.
 * GENIUS_PAY : provider RÉEL, config INJECTÉE depuis l'environnement (secrets
 * déjà validés fail-fast par Zod). `WalletService`/`TopUpService` ne connaissent
 * que le contrat, jamais un provider concret. Aucun secret n'est loggé.
 */
@Injectable()
export class PaymentProviderFactory {
  private readonly provider: PaymentProvider;

  constructor(private readonly config: ConfigService) {
    const name = this.config.get<PaymentProviderName>('PAYMENT_PROVIDER') ?? 'MOCK';
    if (name === 'MOCK') {
      this.provider = new MockPaymentProvider();
    } else if (name === 'GENIUS_PAY') {
      this.provider = new GeniusPayProvider({
        apiBaseUrl: this.config.get<string>('GENIUS_PAY_API_BASE_URL') ?? GENIUS_PAY_DEFAULT_BASE_URL,
        apiKey: this.config.get<string>('GENIUS_PAY_API_KEY'),
        secretKey: this.config.get<string>('GENIUS_PAY_SECRET_KEY'),
        webhookSecret: this.config.get<string>('GENIUS_PAY_WEBHOOK_SECRET'),
        merchantId: this.config.get<string>('GENIUS_PAY_MERCHANT_ID'),
        returnUrl: this.config.get<string>('GENIUS_PAY_RETURN_URL'),
        cancelUrl: this.config.get<string>('GENIUS_PAY_CANCEL_URL'),
        requestTimeoutMs: this.config.get<number>('PAYMENT_REQUEST_TIMEOUT_MS') ?? 30000,
      });
    } else {
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
