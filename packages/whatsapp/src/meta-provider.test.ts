import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MetaCloudWhatsAppProvider } from './meta-provider';
import { WhatsAppProviderSendError } from './types';

const APP_SECRET = 'test-app-secret';

function provider(overrides = {}) {
  return new MetaCloudWhatsAppProvider({
    appSecret: APP_SECRET,
    accessToken: 'test-token',
    phoneNumberId: '123456',
    graphApiVersion: 'v21.0',
    graphBaseUrl: 'https://graph.facebook.com',
    ...overrides,
  });
}

function sign(rawBody: string, secret = APP_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function messageWebhook(overrides: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001', phone_number_id: 'PN_1' },
              contacts: [{ wa_id: '237650000000', profile: { name: 'Awa' } }],
              messages: [
                {
                  from: '237650000000',
                  id: 'wamid.HBg1',
                  timestamp: '1750000000',
                  type: 'text',
                  text: { body: 'Bonjour' },
                  ...overrides,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('MetaCloudWhatsAppProvider.validateInboundEvent — HMAC', () => {
  it('accepte une signature valide', () => {
    const raw = JSON.stringify(messageWebhook());
    expect(provider().validateInboundEvent({ body: {}, rawBody: raw, signature: sign(raw) })).toBe(
      true,
    );
  });

  it('refuse une signature invalide', () => {
    const raw = JSON.stringify(messageWebhook());
    expect(
      provider().validateInboundEvent({ body: {}, rawBody: raw, signature: sign(raw, 'wrong') }),
    ).toBe(false);
  });

  it('refuse une signature absente ou un corps brut absent', () => {
    const raw = JSON.stringify(messageWebhook());
    expect(provider().validateInboundEvent({ body: {}, rawBody: raw })).toBe(false);
    expect(provider().validateInboundEvent({ body: {}, signature: sign(raw) })).toBe(false);
  });

  it('refuse une signature de longueur différente (jamais de throw timingSafeEqual)', () => {
    const raw = JSON.stringify(messageWebhook());
    expect(provider().validateInboundEvent({ body: {}, rawBody: raw, signature: 'sha256=short' })).toBe(
      false,
    );
  });

  it('App Secret absent → erreur de configuration explicite', () => {
    const p = new MetaCloudWhatsAppProvider({ graphApiVersion: 'v21.0', graphBaseUrl: 'x' });
    expect(() => p.validateInboundEvent({ body: {}, rawBody: 'x', signature: 'y' })).toThrow(
      WhatsAppProviderSendError,
    );
  });

  it('signature calculée sur le corps BRUT, pas sur le JSON re-sérialisé', () => {
    // Corps brut avec espacement non canonique : re-sérialiser changerait le HMAC.
    const raw = '{"object":"whatsapp_business_account",  "entry": [] }';
    expect(provider().validateInboundEvent({ body: {}, rawBody: raw, signature: sign(raw) })).toBe(
      true,
    );
  });
});

describe('MetaCloudWhatsAppProvider.parseInboundEvent — messages', () => {
  it('normalise un message texte avec le nom de profil', () => {
    const events = provider().parseInboundEvent({ body: messageWebhook() });
    expect(events).toEqual([
      {
        kind: 'message',
        externalEventId: 'wamid.HBg1',
        externalMessageId: 'wamid.HBg1',
        from: '237650000000',
        displayName: 'Awa',
        messageType: 'TEXT',
        text: 'Bonjour',
        providerTimestamp: '2025-06-15T15:06:40.000Z',
      },
    ]);
  });

  it('conserve le VRAI type des médias, texte null (jamais de conversion)', () => {
    const image = provider().parseInboundEvent({
      body: messageWebhook({ type: 'image', text: undefined, image: { id: 'MEDIA_1' } }),
    });
    expect(image[0]).toMatchObject({ messageType: 'IMAGE', text: null });

    for (const [metaType, expected] of [
      ['audio', 'AUDIO'],
      ['video', 'VIDEO'],
      ['document', 'DOCUMENT'],
      ['location', 'LOCATION'],
      ['contacts', 'CONTACTS'],
      ['sticker', 'STICKER'],
    ] as const) {
      const events = provider().parseInboundEvent({
        body: messageWebhook({ type: metaType, text: undefined }),
      });
      expect(events[0]).toMatchObject({ messageType: expected, text: null });
    }
  });

  it('type inconnu → UNSUPPORTED (jamais d’exception)', () => {
    const events = provider().parseInboundEvent({
      body: messageWebhook({ type: 'button', text: undefined }),
    });
    expect(events[0]).toMatchObject({ messageType: 'UNSUPPORTED', text: null });
  });

  it('payload non structuré → tableau vide', () => {
    expect(provider().parseInboundEvent({ body: null })).toEqual([]);
    expect(provider().parseInboundEvent({ body: { entry: 'x' } })).toEqual([]);
    expect(provider().parseInboundEvent({ body: { entry: [] } })).toEqual([]);
  });
});

describe('MetaCloudWhatsAppProvider.parseInboundEvent — statuts', () => {
  function statusWebhook(status: string, extra: Record<string, unknown> = {}) {
    return {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PN_1' },
                statuses: [
                  { id: 'wamid.OUT', status, timestamp: '1750000000', recipient_id: '237650000000', ...extra },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  it('mappe delivered/read/failed ; ignore sent et inconnus', () => {
    expect(provider().parseInboundEvent({ body: statusWebhook('delivered') })[0]).toMatchObject({
      kind: 'status',
      status: 'DELIVERED',
      externalMessageId: 'wamid.OUT',
      externalEventId: 'status:wamid.OUT:DELIVERED',
    });
    expect(provider().parseInboundEvent({ body: statusWebhook('read') })[0]).toMatchObject({
      status: 'READ',
    });
    expect(provider().parseInboundEvent({ body: statusWebhook('sent') })).toEqual([]);
    expect(provider().parseInboundEvent({ body: statusWebhook('deleted') })).toEqual([]);
  });

  it('failed conserve uniquement code + titre non sensibles', () => {
    const events = provider().parseInboundEvent({
      body: statusWebhook('failed', {
        errors: [{ code: 131047, title: 'Re-engagement message', message: 'x', error_data: { secret: 'no' } }],
      }),
    });
    expect(events[0]).toMatchObject({
      status: 'FAILED',
      errorCode: '131047',
      errorMessage: 'Re-engagement message',
    });
    expect(JSON.stringify(events[0])).not.toContain('secret');
  });
});

describe('MetaCloudWhatsAppProvider.extractPhoneNumberIds', () => {
  it('extrait le phone_number_id des metadata', () => {
    expect(provider().extractPhoneNumberIds(messageWebhook())).toEqual(['PN_1']);
    expect(provider().extractPhoneNumberIds({ entry: [] })).toEqual([]);
  });
});

describe('MetaCloudWhatsAppProvider.parseInboundEventsByPhoneNumber — routage multi-tenant', () => {
  // Un webhook portant DEUX numéros (deux commerçants) dans un seul POST.
  function twoTenantWebhook() {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550001', phone_number_id: 'PN_1' },
                contacts: [{ wa_id: '237650000000', profile: { name: 'Awa' } }],
                messages: [
                  { from: '237650000000', id: 'wamid.A', timestamp: '1750000000', type: 'text', text: { body: 'Chez A' } },
                ],
              },
            },
          ],
        },
        {
          id: 'WABA_2',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550002', phone_number_id: 'PN_2' },
                messages: [
                  { from: '237651111111', id: 'wamid.B', timestamp: '1750000001', type: 'text', text: { body: 'Chez B' } },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  it('groupe les événements par phone_number_id — jamais de fusion inter-tenant', () => {
    const groups = provider().parseInboundEventsByPhoneNumber({ body: twoTenantWebhook() });
    expect(groups).toHaveLength(2);

    const byPhone = new Map(groups.map((g) => [g.phoneNumberId, g.events]));
    expect(byPhone.get('PN_1')).toHaveLength(1);
    expect(byPhone.get('PN_1')?.[0]).toMatchObject({ externalMessageId: 'wamid.A', text: 'Chez A' });
    expect(byPhone.get('PN_2')).toHaveLength(1);
    expect(byPhone.get('PN_2')?.[0]).toMatchObject({ externalMessageId: 'wamid.B', text: 'Chez B' });
  });

  it('un seul numéro → un seul groupe (parité avec parseInboundEvent)', () => {
    const groups = provider().parseInboundEventsByPhoneNumber({ body: messageWebhook() });
    expect(groups).toHaveLength(1);
    expect(groups[0].phoneNumberId).toBe('PN_1');
    expect(groups[0].events).toHaveLength(1);
  });

  it('change sans phone_number_id ou sans événement actionnable → ignoré', () => {
    // Statut 'sent' (non actionnable) avec phone_number_id présent → aucun groupe.
    const sentOnly = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'PN_1' },
                statuses: [{ id: 'wamid.OUT', status: 'sent', timestamp: '1750000000' }],
              },
            },
          ],
        },
      ],
    };
    expect(provider().parseInboundEventsByPhoneNumber({ body: sentOnly })).toEqual([]);
    expect(
      provider().parseInboundEventsByPhoneNumber({
        body: { entry: [{ changes: [{ value: { messages: [{ from: 'x', id: 'i', timestamp: '1', type: 'text', text: { body: 'no meta' } }] } }] }] },
      }),
    ).toEqual([]);
    expect(provider().parseInboundEventsByPhoneNumber({ body: null })).toEqual([]);
  });
});

describe('MetaCloudWhatsAppProvider.mapMetaError — classification', () => {
  it('classe token/permissions en CONFIGURATION_ERROR', () => {
    expect(provider().mapMetaError(401, { error: { code: 190 } }).errorClass).toBe(
      'CONFIGURATION_ERROR',
    );
  });
  it('classe fenêtre fermée en REQUIRES_TEMPLATE', () => {
    expect(provider().mapMetaError(400, { error: { code: 131047 } }).errorClass).toBe(
      'REQUIRES_TEMPLATE',
    );
  });
  it('classe payload/numéro invalide en NON_RETRYABLE', () => {
    expect(provider().mapMetaError(400, { error: { code: 100 } }).errorClass).toBe('NON_RETRYABLE');
  });
  it('classe rate limit / 5xx en RETRYABLE', () => {
    expect(provider().mapMetaError(429, { error: { code: 130429 } }).errorClass).toBe('RETRYABLE');
    expect(provider().mapMetaError(503, {}).errorClass).toBe('RETRYABLE');
  });
  it('ne fuite jamais le corps d’erreur brut dans le message', () => {
    const error = provider().mapMetaError(400, { error: { code: 100, message: 'secret-token-xyz' } });
    expect(error.message).not.toContain('secret-token-xyz');
  });
});
