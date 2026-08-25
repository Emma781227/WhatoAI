import { describe, expect, it } from 'vitest';

import {
  generateMockWamid,
  MOCK_FAIL_TRIGGER,
  MOCK_SIMULATED_FAILURE_CODE,
  MockWhatsAppProvider,
  type MockInboundMessageBody,
  type MockInboundStatusBody,
} from './mock-provider';
import { WhatsAppProviderSendError } from './types';

const CHANNEL = { id: 'chan_1', phoneNumber: '+237650000000' };

function messageBody(overrides: Partial<MockInboundMessageBody> = {}): MockInboundMessageBody {
  return {
    mock: true,
    kind: 'message',
    externalEventId: 'evt_1',
    externalMessageId: 'wamid.mock.abc',
    from: '+237650123456',
    text: 'Bonjour',
    timestamp: '2026-07-17T10:00:00.000Z',
    ...overrides,
  };
}

describe('MockWhatsAppProvider', () => {
  const provider = new MockWhatsAppProvider();

  it('se déclare MOCK', () => {
    expect(provider.getProviderName()).toBe('MOCK');
  });

  describe('validateInboundEvent', () => {
    it('accepte uniquement un body marqué mock: true', () => {
      expect(provider.validateInboundEvent({ body: messageBody() })).toBe(true);
      expect(provider.validateInboundEvent({ body: { kind: 'message' } })).toBe(false);
      expect(provider.validateInboundEvent({ body: null })).toBe(false);
      expect(provider.validateInboundEvent({ body: 'texte' })).toBe(false);
    });
  });

  describe('parseInboundEvent', () => {
    it('normalise un message entrant', () => {
      const events = provider.parseInboundEvent({ body: messageBody({ displayName: 'Alice' }) });
      expect(events).toEqual([
        {
          kind: 'message',
          externalEventId: 'evt_1',
          externalMessageId: 'wamid.mock.abc',
          from: '+237650123456',
          displayName: 'Alice',
          messageType: 'TEXT',
          text: 'Bonjour',
          media: null,
          providerTimestamp: '2026-07-17T10:00:00.000Z',
        },
      ]);
    });

    it('normalise un événement de statut', () => {
      const body: MockInboundStatusBody = {
        mock: true,
        kind: 'status',
        externalEventId: 'evt_2',
        externalMessageId: 'wamid.mock.out',
        status: 'DELIVERED',
        timestamp: '2026-07-17T10:01:00.000Z',
      };
      const events = provider.parseInboundEvent({ body });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'status', status: 'DELIVERED' });
    });

    it('rejette un événement incomplet ou de kind inconnu', () => {
      expect(() =>
        provider.parseInboundEvent({ body: { ...messageBody(), text: undefined } }),
      ).toThrow(WhatsAppProviderSendError);
      expect(() =>
        provider.parseInboundEvent({ body: { mock: true, kind: 'unknown' } }),
      ).toThrow(WhatsAppProviderSendError);
    });
  });

  describe('sendTextMessage', () => {
    it('retourne un externalMessageId wamid.mock.*', async () => {
      const result = await provider.sendTextMessage({
        channel: CHANNEL,
        to: '+237650123456',
        text: 'Bonjour',
        dispatchId: 'disp_1',
      });
      expect(result.externalMessageId).toMatch(/^wamid\.mock\./);
    });

    it(`échoue de façon déterministe quand le texte commence par ${MOCK_FAIL_TRIGGER}`, async () => {
      await expect(
        provider.sendTextMessage({
          channel: CHANNEL,
          to: '+237650123456',
          text: `${MOCK_FAIL_TRIGGER} test erreur`,
          dispatchId: 'disp_2',
        }),
      ).rejects.toMatchObject({ code: MOCK_SIMULATED_FAILURE_CODE });
    });
  });

  it('simulatedStatusPlan : DELIVERED puis READ avec délais cumulés configurables', () => {
    const configured = new MockWhatsAppProvider({ deliveryDelayMs: 100, readDelayMs: 50 });
    expect(configured.simulatedStatusPlan()).toEqual([
      { status: 'DELIVERED', delayMs: 100 },
      { status: 'READ', delayMs: 150 },
    ]);
  });

  it('generateMockWamid produit des identifiants uniques', () => {
    expect(generateMockWamid()).not.toBe(generateMockWamid());
  });
});
