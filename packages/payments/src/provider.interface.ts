import type {
  PaymentProviderName,
  PaymentRequest,
  PaymentSession,
  PaymentStatusResult,
  PaymentWebhookEvent,
} from './types';

/**
 * Contrat commun à tous les providers de paiement. `WalletService`/`TopUpService`
 * ne dépendent JAMAIS d'un provider concret : ils reçoivent une confirmation
 * métier (`payment confirmed → creditTopUp`). Genius Pay implémentera ce contrat
 * plus tard sans toucher au Wallet.
 */
export interface PaymentProvider {
  getProviderName(): PaymentProviderName;

  /** Ouvre une session de paiement chez l'agrégateur pour `request.reference` (TopUp). */
  createPayment(request: PaymentRequest): Promise<PaymentSession>;

  /** Vérifie le statut réel auprès du provider (source de vérité côté agrégateur). */
  getPaymentStatus(providerPaymentId: string): Promise<PaymentStatusResult>;

  /** Normalise un webhook APRÈS vérification de signature. */
  parseWebhook(rawBody: string): PaymentWebhookEvent;

  /**
   * Vérifie la signature d'un webhook (autorité cryptographique unique). Le
   * `returnUrl` du navigateur ne prouve JAMAIS un paiement — seuls le webhook
   * signé ou une vérification serveur (`getPaymentStatus`) le confirment.
   *
   * Forme objet : certains agrégateurs (Genius Pay) signent `timestamp + "." +
   * corps` — la vérification a besoin du timestamp, pas seulement du corps brut.
   */
  verifyWebhookSignature(input: {
    rawBody: string | undefined;
    signature: string | undefined;
    timestamp: string | undefined;
  }): boolean;

  /** Vérifie la config (aucun paiement réel effectué). */
  validateConfiguration(): Promise<{ ok: boolean }>;
}
