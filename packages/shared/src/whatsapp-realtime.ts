/**
 * Payloads des événements Socket.IO (wire format : dates ISO 8601).
 * Champs strictement nécessaires — jamais de payload fournisseur brut, jamais
 * de secret. Les événements ACCÉLÈRENT l'UI ; PostgreSQL reste la source de
 * vérité (toute reconnexion déclenche un refetch de réconciliation).
 */

import type { MessageStatusValue } from './message-status';

export interface RealtimeMessage {
  id: string;
  organizationId: string;
  shopId: string;
  conversationId: string;
  channelId: string;
  contactId: string;
  clientMessageId: string | null;
  direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
  type: string;
  status: MessageStatusValue;
  senderType: 'CUSTOMER' | 'AGENT' | 'AI' | 'SYSTEM';
  senderUserId: string | null;
  textContent: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  mediaFileName: string | null;
  quotedMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RealtimeMessageSource {
  id: string;
  organizationId: string;
  shopId: string;
  conversationId: string;
  channelId: string;
  contactId: string;
  clientMessageId: string | null;
  direction: 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
  type: string;
  status: MessageStatusValue;
  senderType: 'CUSTOMER' | 'AGENT' | 'AI' | 'SYSTEM';
  senderUserId: string | null;
  textContent: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  mediaFileName: string | null;
  quotedMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  readAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function toRealtimeMessage(row: RealtimeMessageSource): RealtimeMessage {
  return {
    ...row,
    sentAt: iso(row.sentAt),
    deliveredAt: iso(row.deliveredAt),
    readAt: iso(row.readAt),
    failedAt: iso(row.failedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** conversation.created / conversation.updated — le client refetch la ressource. */
export interface ConversationChangedEvent {
  organizationId: string;
  shopId: string;
  conversationId: string;
}

export interface ConversationUnreadUpdatedEvent extends ConversationChangedEvent {
  unreadCount: number;
}

export interface MessageCreatedEvent {
  organizationId: string;
  shopId: string;
  conversationId: string;
  message: RealtimeMessage;
}

export interface MessageStatusUpdatedEvent {
  organizationId: string;
  shopId: string;
  conversationId: string;
  messageId: string;
  clientMessageId: string | null;
  status: MessageStatusValue;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** membership.revoked — le client quitte l'organisation immédiatement. */
export interface MembershipRevokedEvent {
  organizationId: string;
}
