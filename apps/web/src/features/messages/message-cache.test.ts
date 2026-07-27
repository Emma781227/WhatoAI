import { describe, expect, it } from 'vitest';

import type { Message } from '@/features/conversations/api';

import {
  applyStatusPatch,
  buildOptimisticMessage,
  upsertMessage,
  type MessagesCache,
  type StatusPatch,
} from './message-cache';

function serverMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_server_1',
    organizationId: 'org_1',
    shopId: 'shop_1',
    conversationId: 'conv_1',
    channelId: 'chan_1',
    contactId: 'contact_1',
    clientMessageId: 'client-uuid-1',
    direction: 'OUTBOUND',
    type: 'TEXT',
    status: 'PENDING',
    senderType: 'AGENT',
    senderUserId: 'user_1',
    senderUser: { id: 'user_1', firstName: 'Awa', lastName: 'Diop' },
    textContent: 'Bonjour',
    mediaUrl: null,
    mediaMimeType: null,
    mediaFileName: null,
    quotedMessageId: null,
    errorCode: null,
    errorMessage: null,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    createdAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:00:00.000Z',
    ...overrides,
  };
}

function cacheWith(...messages: Message[]): MessagesCache {
  return { pages: [{ items: messages, nextCursor: null }], pageParams: [undefined] };
}

function allMessages(cache: MessagesCache): Message[] {
  return cache.pages.flatMap((page) => page.items);
}

const optimistic = buildOptimisticMessage({
  organizationId: 'org_1',
  shopId: 'shop_1',
  conversationId: 'conv_1',
  channelId: 'chan_1',
  contactId: 'contact_1',
  clientMessageId: 'client-uuid-1',
  text: 'Bonjour',
  senderUserId: 'user_1',
  senderFirstName: 'Awa',
  senderLastName: 'Diop',
});

describe('upsertMessage — réconciliation par clientMessageId', () => {
  it('HTTP après optimiste : remplace, jamais de doublon', () => {
    let cache = cacheWith(optimistic);
    cache = upsertMessage(cache, serverMessage());
    const items = allMessages(cache);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('msg_server_1');
  });

  it('socket avant HTTP : le second arrivage ne duplique pas', () => {
    let cache = cacheWith(optimistic);
    cache = upsertMessage(cache, serverMessage({ status: 'SENT' })); // socket
    cache = upsertMessage(cache, serverMessage({ status: 'PENDING' })); // réponse HTTP tardive
    const items = allMessages(cache);
    expect(items).toHaveLength(1);
    // Le statut le plus avancé est conservé (jamais de rétrogradation).
    expect(items[0].status).toBe('SENT');
  });

  it('événement socket dupliqué : une seule entrée', () => {
    let cache = cacheWith();
    cache = upsertMessage(cache, serverMessage());
    cache = upsertMessage(cache, serverMessage());
    expect(allMessages(cache)).toHaveLength(1);
  });

  it('message inbound (sans clientMessageId) : dédoublonné par id', () => {
    const inbound = serverMessage({
      id: 'msg_in_1',
      clientMessageId: null,
      direction: 'INBOUND',
      status: 'RECEIVED',
      senderType: 'CUSTOMER',
    });
    let cache = cacheWith();
    cache = upsertMessage(cache, inbound);
    cache = upsertMessage(cache, inbound);
    expect(allMessages(cache)).toHaveLength(1);
  });

  it('nouveau message : inséré en tête (ordre descendant)', () => {
    const older = serverMessage({ id: 'msg_old', clientMessageId: null });
    let cache = cacheWith(older);
    cache = upsertMessage(cache, serverMessage({ id: 'msg_new', clientMessageId: 'client-2' }));
    expect(allMessages(cache)[0].id).toBe('msg_new');
  });

  it('cache vide : crée la première page', () => {
    const cache = upsertMessage(undefined, serverMessage());
    expect(allMessages(cache)).toHaveLength(1);
  });
});

describe('applyStatusPatch — progression uniquement', () => {
  const patch = (status: StatusPatch['status'], extra: Partial<StatusPatch> = {}): StatusPatch => ({
    messageId: 'msg_server_1',
    clientMessageId: 'client-uuid-1',
    status,
    sentAt: null,
    deliveredAt: null,
    readAt: null,
    failedAt: null,
    errorCode: null,
    errorMessage: null,
    ...extra,
  });

  it('applique une progression (PENDING → SENT)', () => {
    const cache = applyStatusPatch(cacheWith(serverMessage()), patch('SENT', { sentAt: '2026-07-17T10:00:05.000Z' }));
    expect(allMessages(cache!)[0].status).toBe('SENT');
    expect(allMessages(cache!)[0].sentAt).toBe('2026-07-17T10:00:05.000Z');
  });

  it('ignore une rétrogradation (READ puis DELIVERED en retard)', () => {
    let cache = applyStatusPatch(cacheWith(serverMessage()), patch('READ'));
    cache = applyStatusPatch(cache, patch('DELIVERED'));
    expect(allMessages(cache!)[0].status).toBe('READ');
  });

  it('événement dupliqué : no-op', () => {
    let cache = applyStatusPatch(cacheWith(serverMessage()), patch('DELIVERED'));
    const before = allMessages(cache!)[0];
    cache = applyStatusPatch(cache, patch('DELIVERED'));
    expect(allMessages(cache!)[0]).toEqual(before);
  });

  it('retrouve le message par clientMessageId quand l’id ne correspond pas (optimiste)', () => {
    const cache = applyStatusPatch(
      cacheWith(optimistic),
      patch('FAILED', { messageId: 'msg_server_1', failedAt: '2026-07-17T10:00:10.000Z' }),
    );
    expect(allMessages(cache!)[0].status).toBe('FAILED');
  });

  it('message absent du cache : cache inchangé', () => {
    const base = cacheWith(serverMessage());
    const cache = applyStatusPatch(base, patch('SENT', { messageId: 'unknown', clientMessageId: 'unknown' }));
    expect(cache).toEqual(base);
  });
});
