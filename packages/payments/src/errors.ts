import { DomainError } from '@whauto/shared';

/** Erreur générique d'un provider de paiement (jamais de détail brut du gateway). */
export class PaymentProviderError extends DomainError {
  constructor(message: string, code = 'PAYMENT_PROVIDER_ERROR', httpStatus = 502) {
    super(message, code, httpStatus);
    this.name = 'PaymentProviderError';
  }
}

/** 500 : provider mal configuré (clés/URL manquantes) — jamais la clé en clair. */
export class PaymentProviderConfigurationError extends PaymentProviderError {
  constructor() {
    super('Payment provider is not configured.', 'PAYMENT_PROVIDER_CONFIGURATION_ERROR', 500);
    this.name = 'PaymentProviderConfigurationError';
  }
}

/** 502 : provider indisponible (réseau, 5xx gateway). */
export class PaymentProviderUnavailableError extends PaymentProviderError {
  constructor() {
    super('Payment provider is temporarily unavailable.', 'PAYMENT_PROVIDER_UNAVAILABLE', 502);
    this.name = 'PaymentProviderUnavailableError';
  }
}

/** 403 : la confirmation de paiement MOCK n'est pas autorisée dans cet environnement. */
export class MockPaymentDisabledError extends DomainError {
  constructor() {
    super('Mock payments are disabled in this environment.', 'MOCK_PAYMENT_DISABLED', 403);
    this.name = 'MockPaymentDisabledError';
  }
}
