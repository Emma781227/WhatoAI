import type { Conversation, ConversationStatus, MessageStatus } from './api';

export function contactLabel(contact: Conversation['contact']): string {
  return contact.displayName ?? contact.whatsappPhone;
}

export function contactInitials(contact: Conversation['contact']): string {
  const name = contact.displayName;
  if (name) {
    const parts = name.trim().split(/\s+/);
    return `${parts[0]?.charAt(0) ?? ''}${parts[1]?.charAt(0) ?? ''}`.toUpperCase() || '#';
  }
  return contact.whatsappPhone.slice(-2);
}

/** Heure si aujourd'hui, jour sinon, date complète au-delà d'une semaine. */
export function relativeTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  if (now.getTime() - date.getTime() < oneWeekMs) {
    return date.toLocaleDateString('fr-FR', { weekday: 'short' });
  }
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function dayLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return "Aujourd'hui";
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Hier';
  }
  return date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

export function messageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  OPEN: 'Ouverte',
  PENDING: 'En attente',
  RESOLVED: 'Résolue',
  CLOSED: 'Fermée',
};

export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  RECEIVED: 'Reçu',
  PENDING: 'En préparation',
  QUEUED: 'En file',
  SENT: 'Envoyé',
  DELIVERED: 'Distribué',
  READ: 'Lu',
  FAILED: 'Échec',
};
