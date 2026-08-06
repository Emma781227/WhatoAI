import type { PaymentProvider } from './provider.interface';
import type {
  PaymentProviderName,
  PaymentRequest,
  PaymentSession,
  PaymentStatusResult,
  PaymentWebhookEvent,
} from './types';

/**
 * Provider de paiement MOCK — explicitement factice (aucun appel réseau, aucun
 * encaissement réel). Sert au développement et aux e2e sans dépendre d'un
 * agrégateur. La CONFIRMATION passe par un endpoint MOCK explicite côté API
 * (jamais silencieuse) : ce provider ne « paie » rien tout seul.
 */
export class MockPaymentProvider implements PaymentProvider {
  getProviderName(): PaymentProviderName {
    return 'MOCK';
  }

  async createPayment(request: PaymentRequest): Promise<PaymentSession> {
    return {
      provider: 'MOCK',
      providerPaymentId: `mock_pay_${request.reference}`,
      status: 'PENDING',
      // URL factice — clairement identifiable comme simulation, jamais un vrai checkout.
      checkoutUrl: `mock://checkout/${request.reference}`,
      reference: request.reference,
    };
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentStatusResult> {
    // Le mock ne connaît pas l'état réel : la confirmation vient de l'endpoint
    // mock-confirm explicite, pas d'un sondage du provider.
    return { providerPaymentId, status: 'PENDING', reference: null, amount: null, currency: null };
  }

  parseWebhook(rawBody: string): PaymentWebhookEvent {
    const parsed = JSON.parse(rawBody) as {
      externalEventId?: string;
      eventType?: string;
      providerPaymentId?: string;
      status?: PaymentWebhookEvent['status'];
      reference?: string | null;
      amount?: number | null;
      currency?: string | null;
    };
    return {
      externalEventId: parsed.externalEventId ?? '',
      eventType: parsed.eventType ?? '',
      providerPaymentId: parsed.providerPaymentId ?? '',
      status: parsed.status ?? 'PENDING',
      reference: parsed.reference ?? null,
      amount: parsed.amount ?? null,
      currency: parsed.currency ?? null,
    };
  }

  verifyWebhookSignature(): boolean {
    // MOCK : pas de signature réelle. GeniusPayProvider implémente un HMAC réel.
    return true;
  }

  async validateConfiguration(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}
