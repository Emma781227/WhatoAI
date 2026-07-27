import { apiRequest } from '@/lib/api/client';
import type { MembershipRole } from '@/features/organizations/api';

export type ConversationStatus = 'OPEN' | 'PENDING' | 'RESOLVED' | 'CLOSED';
export type ConversationMode = 'HUMAN' | 'AI' | 'HYBRID';
export type ConversationPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type MessageDirection = 'INBOUND' | 'OUTBOUND' | 'INTERNAL';
export type MessageStatus =
  | 'RECEIVED'
  | 'PENDING'
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED';
export type MessageSenderType = 'CUSTOMER' | 'AGENT' | 'AI' | 'SYSTEM';

export interface ContactSummary {
  id: string;
  displayName: string | null;
  whatsappPhone: string;
  normalizedPhone: string;
  profilePictureUrl: string | null;
}

export interface ConversationTag {
  id: string;
  name: string;
  color: string | null;
}

export interface AssignedMembership {
  id: string;
  role: MembershipRole;
  user: { id: string; firstName: string; lastName: string };
}

export interface MessagePreview {
  id: string;
  direction: MessageDirection;
  type: string;
  status: MessageStatus;
  senderType: MessageSenderType;
  textContent: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  organizationId: string;
  shopId: string;
  channelId: string;
  contactId: string;
  status: ConversationStatus;
  mode: ConversationMode;
  aiAutoReplyPaused: boolean;
  priority: ConversationPriority;
  assignedMembershipId: string | null;
  lastMessageAt: string;
  lastInboundMessageAt: string | null;
  lastOutboundMessageAt: string | null;
  unreadCount: number;
  customerServiceWindowExpiresAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  contact: ContactSummary;
  assignedMembership: AssignedMembership | null;
  tags: ConversationTag[];
  lastMessage: MessagePreview | null;
}

export interface Message {
  id: string;
  organizationId: string;
  shopId: string;
  conversationId: string;
  channelId: string;
  contactId: string;
  clientMessageId: string | null;
  direction: MessageDirection;
  type: string;
  status: MessageStatus;
  senderType: MessageSenderType;
  senderUserId: string | null;
  senderUser: { id: string; firstName: string; lastName: string } | null;
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

export interface CursorPage<TItem> {
  items: TItem[];
  nextCursor: string | null;
}

export interface ListConversationsParams {
  shopId?: string;
  status?: ConversationStatus;
  priority?: ConversationPriority;
  assignedMembershipId?: string;
  unassigned?: boolean;
  unreadOnly?: boolean;
  search?: string;
  tagIds?: string[];
  limit?: number;
}

function conversationsBase(organizationId: string): string {
  return `/organizations/${organizationId}/conversations`;
}

function buildListQuery(params: ListConversationsParams, cursor?: string): string {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.shopId) query.set('shopId', params.shopId);
  if (params.status) query.set('status', params.status);
  if (params.priority) query.set('priority', params.priority);
  if (params.assignedMembershipId) query.set('assignedMembershipId', params.assignedMembershipId);
  if (params.unassigned) query.set('unassigned', 'true');
  if (params.unreadOnly) query.set('unreadOnly', 'true');
  if (params.search) query.set('search', params.search);
  for (const tagId of params.tagIds ?? []) {
    query.append('tagIds', tagId);
  }
  return query.size > 0 ? `?${query.toString()}` : '';
}

export const conversationsApi = {
  list(organizationId: string, params: ListConversationsParams, cursor?: string) {
    return apiRequest<CursorPage<Conversation>>(
      `${conversationsBase(organizationId)}${buildListQuery(params, cursor)}`,
    );
  },
  get(organizationId: string, conversationId: string) {
    return apiRequest<Conversation>(`${conversationsBase(organizationId)}/${conversationId}`);
  },
  listMessages(organizationId: string, conversationId: string, cursor?: string, limit = 30) {
    const query = new URLSearchParams();
    query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    return apiRequest<CursorPage<Message>>(
      `${conversationsBase(organizationId)}/${conversationId}/messages?${query.toString()}`,
    );
  },
  sendMessage(
    organizationId: string,
    conversationId: string,
    input: { text: string; clientMessageId: string },
  ) {
    return apiRequest<Message>(`${conversationsBase(organizationId)}/${conversationId}/messages`, {
      method: 'POST',
      body: input,
    });
  },
  retryMessage(organizationId: string, conversationId: string, messageId: string) {
    return apiRequest<Message>(
      `${conversationsBase(organizationId)}/${conversationId}/messages/${messageId}/retry`,
      { method: 'POST' },
    );
  },
  addNote(organizationId: string, conversationId: string, text: string) {
    return apiRequest<Message>(`${conversationsBase(organizationId)}/${conversationId}/notes`, {
      method: 'POST',
      body: { text },
    });
  },
  assign(organizationId: string, conversationId: string, membershipId: string) {
    return apiRequest<Conversation>(
      `${conversationsBase(organizationId)}/${conversationId}/assign`,
      { method: 'POST', body: { membershipId } },
    );
  },
  unassign(organizationId: string, conversationId: string) {
    return apiRequest<Conversation>(
      `${conversationsBase(organizationId)}/${conversationId}/unassign`,
      { method: 'POST' },
    );
  },
  updateStatus(organizationId: string, conversationId: string, status: ConversationStatus) {
    return apiRequest<Conversation>(
      `${conversationsBase(organizationId)}/${conversationId}/status`,
      { method: 'PATCH', body: { status } },
    );
  },
  markRead(organizationId: string, conversationId: string) {
    return apiRequest<Conversation>(`${conversationsBase(organizationId)}/${conversationId}/read`, {
      method: 'POST',
    });
  },
  addTag(organizationId: string, conversationId: string, name: string) {
    return apiRequest<Conversation>(`${conversationsBase(organizationId)}/${conversationId}/tags`, {
      method: 'POST',
      body: { name },
    });
  },
  removeTag(organizationId: string, conversationId: string, tagId: string) {
    return apiRequest<Conversation>(
      `${conversationsBase(organizationId)}/${conversationId}/tags/${tagId}`,
      { method: 'DELETE' },
    );
  },
};

/**
 * Query keys scoppées organizationId (+ shopId dans les filtres de liste) :
 * un changement d'organisation ou de Shop ne peut jamais servir des données
 * de l'ancien contexte.
 */
export const conversationKeys = {
  all: (organizationId: string) => ['organizations', organizationId, 'conversations'] as const,
  list: (organizationId: string, params: ListConversationsParams) =>
    [...conversationKeys.all(organizationId), 'list', params] as const,
  detail: (organizationId: string, conversationId: string) =>
    [...conversationKeys.all(organizationId), 'detail', conversationId] as const,
  messages: (organizationId: string, conversationId: string) =>
    [...conversationKeys.all(organizationId), 'messages', conversationId] as const,
};
