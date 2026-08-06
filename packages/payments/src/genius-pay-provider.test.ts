import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GeniusPayProvider } from './genius-pay-provider';
import { mapGeniusPayStatus } from './genius-pay-status';
import type { PaymentProviderConfig } from './types';

/**
 * Tests du VRAI GeniusPayProvider contre un FAUX serveur Genius Pay reproduisant
 * exactement le contrat officiel (`pay.genius.ci/docs/api`) : en-têtes d'auth,
 * create payment, get status, statuts, erreurs, timeout, signature webhook
 * (`timestamp + "." + corps`, HMAC-SHA256, secret whsec_), non-fuite des secrets.
 * Aucun appel réseau vers Genius Pay.
 */

const WEBHOOK_SECRET = 'whsec_sandbox_test_secret';
const API_KEY = 'pk_sandbox_test';
const API_SECRET = 'sk_sandbox_test';

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let lastRequest: CapturedRequest | null = null;
// Comportement injectable du faux serveur par test.
let handler: (req: CapturedRequest) => { status: number; body: unknown } | 'HANG';

function makeConfig(overrides: Partial<PaymentProviderConfig> = {}): PaymentProviderConfig {
  return {
    apiBaseUrl: baseUrl,
    apiKey: API_KEY,
    secretKey: API_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw.length > 0 ? JSON.parse(raw) : undefined,
      };
      lastRequest = captured;
      const result = handler(captured);
      if (result === 'HANG') {
        return; // Ne répond jamais → déclenche le timeout côté provider.
      }
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('mapGeniusPayStatus — statuts officiels', () => {
  it('mappe chaque statut documenté', () => {
    expect(mapGeniusPayStatus('pending')).toBe('PENDING');
    expect(mapGeniusPayStatus('processing')).toBe('PROCESSING');
    expect(mapGeniusPayStatus('completed')).toBe('PAID');
    expect(mapGeniusPayStatus('failed')).toBe('FAILED');
    expect(mapGeniusPayStatus('cancelled')).toBe('CANCELLED');
    expect(mapGeniusPayStatus('refunded')).toBe('REFUNDED');
    expect(mapGeniusPayStatus('expired')).toBe('EXPIRED');
  });

  it('statut inconnu → PENDING (jamais PAID par défaut)', () => {
    expect(mapGeniusPayStatus('weird_status')).toBe('PENDING');
    expect(mapGeniusPayStatus('')).toBe('PENDING');
  });
});

describe('GeniusPayProvider.createPayment', () => {
  it('envoie X-API-Key/X-API-Secret + corps conforme, parse la réponse 201', async () => {
    handler = () => ({
      status: 201,
      body: {
        success: true,
        data: {
          id: 4242,
          reference: 'MTX-ABCDEF1234',
          amount: 500,
          status: 'pending',
          checkout_url: 'https://pay.genius.ci/checkout/MTX-ABCDEF1234',
        },
      },
    });
    const provider = new GeniusPayProvider(makeConfig());
    const session = await provider.createPayment({
      reference: 'topup-77',
      amountMinor: 500,
      currency: 'XAF',
      description: 'Pack Découverte',
      returnUrl: 'https://app.whauto/return',
      cancelUrl: 'https://app.whauto/cancel',
    });

    expect(session).toMatchObject({
      provider: 'GENIUS_PAY',
      providerPaymentId: 'MTX-ABCDEF1234',
      status: 'PENDING',
      reference: 'topup-77',
      checkoutUrl: 'https://pay.genius.ci/checkout/MTX-ABCDEF1234',
    });
    // Auth par en-têtes marchand.
    expect(lastRequest?.headers['x-api-key']).toBe(API_KEY);
    expect(lastRequest?.headers['x-api-secret']).toBe(API_SECRET);
    expect(lastRequest?.method).toBe('POST');
    expect(lastRequest?.url).toBe('/api/v1/merchant/payments');
    // Montant en unité MAJEURE (XAF = 0 décimale) + corrélation dans metadata.
    const body = lastRequest?.body as { amount: number; currency: string; metadata: { reference: string }; success_url: string };
    expect(body.amount).toBe(500);
    expect(body.currency).toBe('XAF');
    expect(body.metadata.reference).toBe('topup-77');
    expect(body.success_url).toBe('https://app.whauto/return');
  });

  it('success_url/error_url absents de la requête → repli sur la config marchand', async () => {
    handler = () => ({ status: 201, body: { success: true, data: { reference: 'MTX-R', status: 'pending' } } });
    const provider = new GeniusPayProvider(
      makeConfig({ returnUrl: 'https://app.whauto/billing/return', cancelUrl: 'https://app.whauto/billing/cancel' }),
    );
    await provider.createPayment({ reference: 't', amountMinor: 300, currency: 'XAF' });
    const body = lastRequest?.body as { success_url: string; error_url: string };
    expect(body.success_url).toBe('https://app.whauto/billing/return');
    expect(body.error_url).toBe('https://app.whauto/billing/cancel');
  });

  it('checkout_url absent → repli sur payment_url', async () => {
    handler = () => ({
      status: 201,
      body: { success: true, data: { reference: 'MTX-2', status: 'pending', payment_url: 'https://pay.genius.ci/p/MTX-2' } },
    });
    const provider = new GeniusPayProvider(makeConfig());
    const session = await provider.createPayment({ reference: 't', amountMinor: 300, currency: 'XAF' });
    expect(session.checkoutUrl).toBe('https://pay.genius.ci/p/MTX-2');
  });

  it('réponse sans reference → erreur provider (jamais de session invalide)', async () => {
    handler = () => ({ status: 201, body: { success: true, data: { status: 'pending' } } });
    const provider = new GeniusPayProvider(makeConfig());
    await expect(provider.createPayment({ reference: 't', amountMinor: 300, currency: 'XAF' })).rejects.toMatchObject({
      code: 'GENIUS_PAY_INVALID_RESPONSE',
    });
  });
});

describe('GeniusPayProvider.getPaymentStatus', () => {
  it('récupère et mappe le statut + amount/currency + reference (metadata)', async () => {
    handler = () => ({
      status: 200,
      body: {
        success: true,
        data: {
          reference: 'MTX-9',
          amount: 500,
          currency: 'XAF',
          status: 'completed',
          metadata: { reference: 'topup-9' },
          completed_at: '2026-08-01T10:00:00Z',
        },
      },
    });
    const provider = new GeniusPayProvider(makeConfig());
    const result = await provider.getPaymentStatus('MTX-9');
    expect(result).toEqual({
      providerPaymentId: 'MTX-9',
      status: 'PAID',
      reference: 'topup-9',
      amount: 500,
      currency: 'XAF',
    });
    expect(lastRequest?.method).toBe('GET');
    expect(lastRequest?.url).toBe('/api/v1/merchant/payments/MTX-9');
  });
});

describe('GeniusPayProvider — erreurs', () => {
  it('401 INVALID_API_KEY → GENIUS_PAY_UNAUTHORIZED', async () => {
    handler = () => ({ status: 401, body: { success: false, error: { code: 'INVALID_API_KEY', message: 'x' } } });
    const provider = new GeniusPayProvider(makeConfig());
    await expect(provider.getPaymentStatus('MTX-x')).rejects.toMatchObject({ code: 'GENIUS_PAY_UNAUTHORIZED' });
  });

  it('404 TRANSACTION_NOT_FOUND → GENIUS_PAY_NOT_FOUND', async () => {
    handler = () => ({ status: 404, body: { success: false, error: { code: 'TRANSACTION_NOT_FOUND' } } });
    const provider = new GeniusPayProvider(makeConfig());
    await expect(provider.getPaymentStatus('MTX-x')).rejects.toMatchObject({ code: 'GENIUS_PAY_NOT_FOUND' });
  });

  it('422 VALIDATION_ERROR → GENIUS_PAY_VALIDATION_ERROR', async () => {
    handler = () => ({ status: 422, body: { success: false, error: { code: 'VALIDATION_ERROR' } } });
    const provider = new GeniusPayProvider(makeConfig());
    await expect(provider.createPayment({ reference: 't', amountMinor: 100, currency: 'XAF' })).rejects.toMatchObject({
      code: 'GENIUS_PAY_VALIDATION_ERROR',
    });
  });

  it('5xx → provider indisponible', async () => {
    handler = () => ({ status: 503, body: { success: false } });
    const provider = new GeniusPayProvider(makeConfig());
    await expect(provider.getPaymentStatus('MTX-x')).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
  });

  it('timeout → GENIUS_PAY_TIMEOUT', async () => {
    handler = () => 'HANG';
    const provider = new GeniusPayProvider(makeConfig({ requestTimeoutMs: 200 }));
    await expect(provider.getPaymentStatus('MTX-x')).rejects.toMatchObject({ code: 'GENIUS_PAY_TIMEOUT' });
  });

  it('config incomplète → erreur de configuration (aucun appel réseau)', async () => {
    const provider = new GeniusPayProvider(makeConfig({ apiKey: undefined }));
    await expect(provider.getPaymentStatus('MTX-x')).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_CONFIGURATION_ERROR',
    });
  });
});

describe('GeniusPayProvider.verifyWebhookSignature', () => {
  const rawBody = JSON.stringify({
    id: 'evt_123',
    event: 'payment.success',
    data: { reference: 'MTX-9', status: 'completed' },
  });
  const timestamp = '1754049600';
  const validSignature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest('hex');
  const provider = () => new GeniusPayProvider(makeConfig());

  it('signature valide (timestamp + "." + corps brut) → true', () => {
    expect(provider().verifyWebhookSignature({ rawBody, signature: validSignature, timestamp })).toBe(true);
  });

  it('signature calculée sur le corps SEUL (sans timestamp) → false', () => {
    const wrong = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    expect(provider().verifyWebhookSignature({ rawBody, signature: wrong, timestamp })).toBe(false);
  });

  it('mauvais secret → false', () => {
    const wrong = createHmac('sha256', 'whsec_wrong').update(`${timestamp}.${rawBody}`).digest('hex');
    expect(provider().verifyWebhookSignature({ rawBody, signature: wrong, timestamp })).toBe(false);
  });

  it('timestamp / signature manquants → false', () => {
    expect(provider().verifyWebhookSignature({ rawBody, signature: validSignature, timestamp: undefined })).toBe(false);
    expect(provider().verifyWebhookSignature({ rawBody, signature: undefined, timestamp })).toBe(false);
    expect(provider().verifyWebhookSignature({ rawBody: undefined, signature: validSignature, timestamp })).toBe(false);
  });

  it('corps altéré (rejeu modifié) → false', () => {
    const tampered = rawBody.replace('completed', 'failed');
    expect(provider().verifyWebhookSignature({ rawBody: tampered, signature: validSignature, timestamp })).toBe(false);
  });
});

describe('GeniusPayProvider.parseWebhook', () => {
  it('extrait id, event, reference provider, statut, reference metadata, amount/currency', () => {
    const rawBody = JSON.stringify({
      id: 'evt_777',
      event: 'payment.success',
      timestamp: '1754049600',
      data: {
        object: 'payment',
        reference: 'MTX-42',
        amount: 500,
        currency: 'XAF',
        status: 'completed',
        metadata: { reference: 'topup-42' },
      },
      environment: 'sandbox',
      api_version: 'v1',
    });
    const event = new GeniusPayProvider(makeConfig()).parseWebhook(rawBody);
    expect(event).toEqual({
      externalEventId: 'evt_777',
      eventType: 'payment.success',
      providerPaymentId: 'MTX-42',
      status: 'PAID',
      reference: 'topup-42',
      amount: 500,
      currency: 'XAF',
    });
  });
});

describe('GeniusPayProvider.validateConfiguration', () => {
  it('404 sentinelle → auth valide (ok:true), aucun paiement', async () => {
    handler = () => ({ status: 404, body: { success: false, error: { code: 'TRANSACTION_NOT_FOUND' } } });
    const provider = new GeniusPayProvider(makeConfig());
    expect(await provider.validateConfiguration()).toEqual({ ok: true });
    expect(lastRequest?.method).toBe('GET');
  });

  it('401 → ok:false', async () => {
    handler = () => ({ status: 401, body: { success: false, error: { code: 'INVALID_API_KEY' } } });
    const provider = new GeniusPayProvider(makeConfig());
    expect(await provider.validateConfiguration()).toEqual({ ok: false });
  });
});

describe('GeniusPayProvider — non-fuite des secrets', () => {
  it('les erreurs ne contiennent jamais les clés/secret', async () => {
    handler = () => ({ status: 401, body: { success: false, error: { code: 'INVALID_API_KEY' } } });
    const provider = new GeniusPayProvider(makeConfig());
    try {
      await provider.getPaymentStatus('MTX-x');
      throw new Error('should have thrown');
    } catch (error) {
      const serialized = `${(error as Error).message} ${JSON.stringify(error)}`;
      expect(serialized).not.toContain(API_KEY);
      expect(serialized).not.toContain(API_SECRET);
      expect(serialized).not.toContain(WEBHOOK_SECRET);
    }
  });
});
