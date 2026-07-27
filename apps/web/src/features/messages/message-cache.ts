import { isStatusUpgrade } from '@whauto/shared';

import type { CursorPage, Message, MessageStatus } from '@/features/conversations/api';

/**
 * Réconciliation du cache de messages — POINT D'ENTRÉE UNIQUE pour :
 * l'insertion optimiste, la réponse HTTP de la mutation et l'événement
 * Socket.IO message.created. Un message est identifié par `id` OU par
 * `clientMessageId` : quel que soit l'ordre d'arrivée (HTTP avant socket,
 * socket avant HTTP, événement dupliqué), il n'existe qu'UNE entrée en cache.
 *
 * Les statuts ne s'appliquent qu'en progression (source unique
 * @whauto/shared) : un DELIVERED arrivant après un READ est ignoré.
 */

export type MessagesCache = { pages: CursorPage<Message>[]; pageParams: unknown[] };

function sameMessage(a: Message, b: Message): boolean {
  if (a.id === b.id) {
    return true;
  }
  return (
    a.clientMessageId !== null &&
    b.clientMessageId !== null &&
    a.clientMessageId === b.clientMessageId
  );
}

/** Le remplaçant garde le statut le plus avancé des deux versions. */
function merge(existing: Message, incoming: Message): Message {
  const keepExistingStatus =
    existing.status !== incoming.status && !isStatusUpgrade(existing.status, incoming.status);
  if (!keepExistingStatus) {
    return incoming;
  }
  return {
    ...incoming,
    status: existing.status,
    sentAt: incoming.sentAt ?? existing.sentAt,
    deliveredAt: incoming.deliveredAt ?? existing.deliveredAt,
    readAt: incoming.readAt ?? existing.readAt,
    failedAt: incoming.failedAt ?? existing.failedAt,
  };
}

/** Insère (en tête — ordre descendant) ou remplace, sans jamais dupliquer. */
export function upsertMessage(cache: MessagesCache | undefined, incoming: Message): MessagesCache {
  if (!cache || cache.pages.length === 0) {
    return { pages: [{ items: [incoming], nextCursor: null }], pageParams: [undefined] };
  }

  let replaced = false;
  const pages = cache.pages.map((page) => {
    const index = page.items.findIndex((item) => sameMessage(item, incoming));
    if (index === -1) {
      return page;
    }
    replaced = true;
    const items = [...page.items];
    items[index] = merge(items[index], incoming);
    return { ...page, items };
  });

  if (replaced) {
    return { ...cache, pages };
  }
  const [first, ...rest] = cache.pages;
  return {
    ...cache,
    pages: [{ ...first, items: [incoming, ...first.items] }, ...rest],
  };
}

export interface StatusPatch {
  messageId: string;
  clientMessageId: string | null;
  status: MessageStatus;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Applique une mise à jour de statut si (et seulement si) elle fait
 * progresser le message — jamais de rétrogradation, événement dupliqué = no-op.
 */
export function applyStatusPatch(
  cache: MessagesCache | undefined,
  patch: StatusPatch,
): MessagesCache | undefined {
  if (!cache) {
    return cache;
  }
  const pages = cache.pages.map((page) => {
    const index = page.items.findIndex(
      (item) =>
        item.id === patch.messageId ||
        (item.clientMessageId !== null && item.clientMessageId === patch.clientMessageId),
    );
    if (index === -1) {
      return page;
    }
    const current = page.items[index];
    if (!isStatusUpgrade(current.status, patch.status)) {
      return page;
    }
    const items = [...page.items];
    items[index] = {
      ...current,
      status: patch.status,
      sentAt: patch.sentAt ?? current.sentAt,
      deliveredAt: patch.deliveredAt ?? current.deliveredAt,
      readAt: patch.readAt ?? current.readAt,
      failedAt: patch.failedAt ?? current.failedAt,
      errorCode: patch.errorCode ?? current.errorCode,
      errorMessage: patch.errorMessage ?? current.errorMessage,
    };
    return { ...page, items };
  });
  return { ...cache, pages };
}

/** Message optimiste affiché immédiatement, remplacé à la réconciliation. */
export function buildOptimisticMessage(input: {
  organizationId: string;
  shopId: string;
  conversationId: string;
  channelId: string;
  contactId: string;
  clientMessageId: string;
  text: string;
  senderUserId: string;
  senderFirstName: string;
  senderLastName: string;
}): Message {
  const now = new Date().toISOString();
  return {
    // Préfixe explicite : jamais confondu avec un cuid serveur.
    id: `optimistic:${input.clientMessageId}`,
    organizationId: input.organizationId,
    shopId: input.shopId,
    conversationId: input.conversationId,
    channelId: input.channelId,
    contactId: input.contactId,
    clientMessageId: input.clientMessageId,
    direction: 'OUTBOUND',
    type: 'TEXT',
    status: 'PENDING',
    senderType: 'AGENT',
    senderUserId: input.senderUserId,
    senderUser: {
      id: input.senderUserId,
      firstName: input.senderFirstName,
      lastName: input.senderLastName,
    },
    textContent: input.text,
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
    createdAt: now,
    updatedAt: now,
  };
}
