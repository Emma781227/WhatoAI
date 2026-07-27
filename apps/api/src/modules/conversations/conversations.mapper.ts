import type { Prisma } from '@whauto/database';

import { CONTACT_SUMMARY_SELECT } from '../contacts/contacts.mapper';

/**
 * Seuls champs Message autorisés à sortir de la couche service.
 * providerPayload, dispatchId et attemptCount restent internes (le payload
 * filtré ne sert qu'au diagnostic backend, jamais à l'UI).
 */
export const MESSAGE_PUBLIC_SELECT = {
  id: true,
  organizationId: true,
  shopId: true,
  conversationId: true,
  channelId: true,
  contactId: true,
  clientMessageId: true,
  direction: true,
  type: true,
  status: true,
  senderType: true,
  senderUserId: true,
  senderUser: { select: { id: true, firstName: true, lastName: true } },
  textContent: true,
  mediaUrl: true,
  mediaMimeType: true,
  mediaFileName: true,
  quotedMessageId: true,
  errorCode: true,
  errorMessage: true,
  sentAt: true,
  deliveredAt: true,
  readAt: true,
  failedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MessageSelect;

export type MessagePublic = Prisma.MessageGetPayload<{ select: typeof MESSAGE_PUBLIC_SELECT }>;

/** Aperçu du dernier message dans la liste des conversations. */
export const MESSAGE_PREVIEW_SELECT = {
  id: true,
  direction: true,
  type: true,
  status: true,
  senderType: true,
  textContent: true,
  createdAt: true,
} satisfies Prisma.MessageSelect;

export const CONVERSATION_TAG_SELECT = {
  tag: { select: { id: true, name: true, color: true } },
} satisfies Prisma.ConversationTagSelect;

export const CONVERSATION_PUBLIC_SELECT = {
  id: true,
  organizationId: true,
  shopId: true,
  channelId: true,
  contactId: true,
  status: true,
  mode: true,
  aiAutoReplyPaused: true,
  priority: true,
  assignedMembershipId: true,
  lastMessageAt: true,
  lastInboundMessageAt: true,
  lastOutboundMessageAt: true,
  unreadCount: true,
  customerServiceWindowExpiresAt: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  contact: { select: CONTACT_SUMMARY_SELECT },
  assignedMembership: {
    select: {
      id: true,
      role: true,
      user: { select: { id: true, firstName: true, lastName: true } },
    },
  },
  tags: { select: CONVERSATION_TAG_SELECT },
  // Aperçu inbox : le dernier message (les notes internes en font partie côté
  // équipe — l'inbox est une vue interne).
  messages: {
    select: MESSAGE_PREVIEW_SELECT,
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 1,
  },
} satisfies Prisma.ConversationSelect;

export type ConversationPublic = Prisma.ConversationGetPayload<{
  select: typeof CONVERSATION_PUBLIC_SELECT;
}>;
