import { createHmac, timingSafeEqual } from 'node:crypto';

import { toMajorUnits } from './amounts';
import { mapGeniusPayStatus } from './genius-pay-status';
import {
  PaymentProviderConfigurationError,
  PaymentProviderError,
  PaymentProviderUnavailableError,
} from './errors';
import type { PaymentProvider } from './provider.interface';
import type {
  PaymentProviderConfig,
  PaymentProviderName,
  PaymentRequest,
  PaymentSession,
  PaymentStatusResult,
  PaymentWebhookEvent,
} from './types';

/**
 * Provider Genius Pay RÉEL (`pay.genius.ci`) — package PUR : config INJECTÉE,
 * aucun `process.env`, AUCUNE logique de crédits/Wallet. Contrat strictement
 * conforme à la doc officielle :
 * - auth marchand par en-têtes `X-API-Key` (pk_) + `X-API-Secret` (sk_) ;
 * - `POST /merchant/payments` (montant en unité MAJEURE, min 200) ;
 * - `GET /merchant/payments/{reference}` ;
 * - webhook signé HMAC-SHA256 sur `timestamp + "." + corps` avec le secret
 *   DÉDIÉ `whsec_…` (jamais la clé `sk_`), en-tête `X-Webhook-Signature`.
 *
 * `apiBaseUrl` est surchargeable → les tests exercent le VRAI provider contre un
 * faux serveur reproduisant le contrat, sans jamais appeler Genius Pay.
 */
export class GeniusPayProvider implements PaymentProvider {
  constructor(private readonly config: PaymentProviderConfig) {}

  getProviderName(): PaymentProviderName {
    return 'GENIUS_PAY';
  }

  async createPayment(request: PaymentRequest): Promise<PaymentSession> {
    this.assertConfigured();
    const body = {
      amount: toMajorUnits(request.amountMinor, request.currency),
      currency: request.currency,
      description: request.description,
      // Corrélation : notre id de TopUp est renvoyé verbatim dans les webhooks.
      metadata: { ...(request.metadata ?? {}), reference: request.reference },
      // URLs de retour : celles de la requête, sinon la config marchand injectée
      // (GENIUS_PAY_RETURN_URL/CANCEL_URL) — le client revient sur la page de
      // suivi Whauto, qui SONDE le statut (le retour n'est jamais une preuve).
      success_url: request.returnUrl ?? this.config.returnUrl,
      error_url: request.cancelUrl ?? this.config.cancelUrl,
    };
    const parsed = (await this.request('POST', '/merchant/payments', body)) as GeniusEnvelope;
    const data = parsed?.data;
    if (!data?.reference) {
      throw new PaymentProviderError(
        'Genius Pay create payment: missing reference in response.',
        'GENIUS_PAY_INVALID_RESPONSE',
        502,
      );
    }
    return {
      provider: 'GENIUS_PAY',
      providerPaymentId: String(data.reference),
      status: mapGeniusPayStatus(String(data.status ?? 'pending')),
      checkoutUrl: (data.checkout_url ?? data.payment_url ?? null) as string | null,
      reference: request.reference,
    };
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentStatusResult> {
    this.assertConfigured();
    const parsed = (await this.request(
      'GET',
      `/merchant/payments/${encodeURIComponent(providerPaymentId)}`,
    )) as GeniusEnvelope;
    const data = parsed?.data;
    if (!data) {
      throw new PaymentProviderError(
        'Genius Pay status: missing data in response.',
        'GENIUS_PAY_INVALID_RESPONSE',
        502,
      );
    }
    return {
      providerPaymentId: String(data.reference ?? providerPaymentId),
      status: mapGeniusPayStatus(String(data.status ?? 'pending')),
      reference: readReference(data.metadata),
      amount: typeof data.amount === 'number' ? data.amount : null,
      currency: (data.currency as string | undefined) ?? null,
    };
  }

  parseWebhook(rawBody: string): PaymentWebhookEvent {
    const payload = JSON.parse(rawBody) as GeniusWebhookPayload;
    const data = payload?.data ?? {};
    return {
      externalEventId: String(payload?.id ?? ''),
      eventType: String(payload?.event ?? ''),
      providerPaymentId: String(data.reference ?? ''),
      status: mapGeniusPayStatus(String(data.status ?? 'pending')),
      reference: readReference(data.metadata),
      amount: typeof data.amount === 'number' ? data.amount : null,
      currency: (data.currency as string | undefined) ?? null,
    };
  }

  /**
   * Vérifie la signature du webhook : HMAC-SHA256 de `timestamp + "." + corps
   * BRUT` avec le secret DÉDIÉ `whsec_…`, comparaison timing-safe. Le corps brut
   * reçu EST exactement la donnée signée par Genius Pay — jamais re-sérialiser.
   */
  verifyWebhookSignature(input: {
    rawBody: string | undefined;
    signature: string | undefined;
    timestamp: string | undefined;
  }): boolean {
    const secret = this.config.webhookSecret;
    if (!secret || !input.rawBody || !input.signature || !input.timestamp) {
      return false;
    }
    const expected = createHmac('sha256', secret)
      .update(`${input.timestamp}.${input.rawBody}`)
      .digest('hex');
    return safeEqualHex(expected, input.signature);
  }

  /**
   * Valide la configuration SANS aucun paiement : GET d'une référence sentinelle.
   * Auth invalide (401) → ok:false ; TRANSACTION_NOT_FOUND (404) → auth valide,
   * ok:true. Ne renvoie et ne logge aucun secret.
   */
  async validateConfiguration(): Promise<{ ok: boolean }> {
    this.assertConfigured();
    try {
      await this.request('GET', '/merchant/payments/__whauto_healthcheck__');
      return { ok: true };
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        if (error.code === 'GENIUS_PAY_NOT_FOUND') {
          return { ok: true }; // Auth acceptée, transaction sentinelle inexistante.
        }
        if (error.code === 'GENIUS_PAY_UNAUTHORIZED' || error.code === 'GENIUS_PAY_MERCHANT_INACTIVE') {
          return { ok: false };
        }
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- HTTP privé

  private assertConfigured(): void {
    if (!this.config.apiBaseUrl || !this.config.apiKey || !this.config.secretKey) {
      throw new PaymentProviderConfigurationError();
    }
  }

  private async request(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs ?? 30000);
    let response: Response;
    try {
      response = await fetch(`${this.config.apiBaseUrl}${path}`, {
        method,
        headers: {
          'X-API-Key': this.config.apiKey ?? '',
          'X-API-Secret': this.config.secretKey ?? '',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: method === 'POST' ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      throw isAbort
        ? new PaymentProviderError('Genius Pay request timed out.', 'GENIUS_PAY_TIMEOUT', 504)
        : new PaymentProviderUnavailableError();
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      throw this.mapError(response.status, parsed);
    }
    return parsed;
  }

  /** Classe les erreurs Genius Pay — jamais de secret ni de payload brut du gateway. */
  private mapError(status: number, parsed: unknown): PaymentProviderError {
    const code = (parsed as { error?: { code?: string } } | undefined)?.error?.code;
    if (status === 401) {
      return new PaymentProviderError('Genius Pay authentication failed.', 'GENIUS_PAY_UNAUTHORIZED', 502);
    }
    if (status === 403) {
      return new PaymentProviderError('Genius Pay merchant inactive.', 'GENIUS_PAY_MERCHANT_INACTIVE', 502);
    }
    if (status === 404) {
      return new PaymentProviderError('Genius Pay transaction not found.', 'GENIUS_PAY_NOT_FOUND', 404);
    }
    if (status === 422) {
      return new PaymentProviderError(
        `Genius Pay validation error${code ? ` (${code})` : ''}.`,
        'GENIUS_PAY_VALIDATION_ERROR',
        502,
      );
    }
    if (status >= 500) {
      return new PaymentProviderUnavailableError();
    }
    return new PaymentProviderError('Genius Pay request failed.', 'GENIUS_PAY_ERROR', 502);
  }
}

// ---------------------------------------------------------------- helpers purs

interface GeniusEnvelope {
  success?: boolean;
  data?: {
    id?: number | string;
    reference?: string;
    amount?: number;
    currency?: string;
    status?: string;
    checkout_url?: string | null;
    payment_url?: string | null;
    metadata?: unknown;
  };
}

interface GeniusWebhookPayload {
  id?: string | number;
  event?: string;
  timestamp?: string | number;
  data?: {
    reference?: string;
    amount?: number;
    currency?: string;
    status?: string;
    metadata?: unknown;
  };
}

/** Lit `metadata.reference` (notre id de TopUp) de façon défensive. */
function readReference(metadata: unknown): string | null {
  if (metadata && typeof metadata === 'object' && 'reference' in metadata) {
    const value = (metadata as { reference?: unknown }).reference;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/** Comparaison timing-safe de deux signatures hexadécimales (longueurs différentes → false). */
function safeEqualHex(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}
