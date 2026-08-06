import { describe, expect, it } from 'vitest';

import { MockPaymentProvider } from './mock-provider';

const provider = new MockPaymentProvider();

describe('MockPaymentProvider', () => {
  it('crée une session PENDING avec une URL factice liée à la référence', async () => {
    const session = await provider.createPayment({ reference: 'topup-1', amountMinor: 500, currency: 'XAF' });
    expect(session).toMatchObject({
      provider: 'MOCK',
      providerPaymentId: 'mock_pay_topup-1',
      status: 'PENDING',
      reference: 'topup-1',
    });
    expect(session.checkoutUrl).toContain('mock://');
  });

  it('getPaymentStatus renvoie PENDING (la confirmation est explicite, pas un sondage)', async () => {
    const status = await provider.getPaymentStatus('mock_pay_topup-1');
    expect(status.status).toBe('PENDING');
  });

  it('parseWebhook normalise le corps sans planter', () => {
    const event = provider.parseWebhook(JSON.stringify({ providerPaymentId: 'p1', status: 'PAID', reference: 'r1' }));
    expect(event).toMatchObject({ providerPaymentId: 'p1', status: 'PAID', reference: 'r1' });
  });

  it('validateConfiguration ok et nom de provider MOCK', async () => {
    expect(provider.getProviderName()).toBe('MOCK');
    expect(await provider.validateConfiguration()).toEqual({ ok: true });
  });
});
