/**
 * Noms des queues BullMQ — constantes partagées entre l'API (producteurs) et
 * le worker (consommateurs). Volontairement PAS des variables d'environnement :
 * deux .env désynchronisés feraient silencieusement disparaître les jobs.
 */
export const WHATSAPP_QUEUES = {
  INBOUND: 'whatsapp-inbound',
  OUTBOUND: 'whatsapp-outbound',
  STATUS: 'whatsapp-status',
} as const;

export type WhatsAppQueueName = (typeof WHATSAPP_QUEUES)[keyof typeof WHATSAPP_QUEUES];

/**
 * Queues IA — mêmes règles que WHATSAPP_QUEUES (constantes, jamais des
 * variables d'environnement). `ai-process-message` orchestre une génération de
 * suggestion pour UN message déclencheur.
 */
export const AI_QUEUES = {
  PROCESS_MESSAGE: 'ai-process-message',
} as const;

export type AiQueueName = (typeof AI_QUEUES)[keyof typeof AI_QUEUES];

/**
 * Événements Socket.IO serveur → client. Les payloads ne contiennent que le
 * strict nécessaire (jamais de secret, jamais de payload fournisseur brut).
 * Les événements sockets ACCÉLÈRENT l'UI mais ne sont jamais la source de
 * vérité : toute reconnexion déclenche un refetch de réconciliation.
 */
export const SOCKET_EVENTS = {
  CONVERSATION_CREATED: 'conversation.created',
  CONVERSATION_UPDATED: 'conversation.updated',
  MESSAGE_CREATED: 'message.created',
  MESSAGE_STATUS_UPDATED: 'message.status.updated',
  CONVERSATION_UNREAD_UPDATED: 'conversation.unread.updated',
  /** L'accès du user à l'organisation a été révoqué : quitter les rooms immédiatement. */
  MEMBERSHIP_REVOKED: 'membership.revoked',
  // Panier conversationnel — payloads = RÉFÉRENCES + version uniquement
  // (décision validée) : le frontend refetch les données autoritaires, jamais
  // de payload complet de Cart/Checkout dans les sockets.
  CART_UPDATED: 'cart.updated',
  CART_RESERVATION_UPDATED: 'cart.reservation.updated',
  CHECKOUT_UPDATED: 'checkout.updated',
  CHECKOUT_CONFIRMED: 'checkout.confirmed',
  // Orders — mêmes règles : références + version, le frontend refetch.
  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',
  ORDER_STATUS_UPDATED: 'order.status.updated',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_NOTE_CREATED: 'order.note.created',
  // IA — RÉFÉRENCES uniquement (jamais de contenu de suggestion, prompt ou
  // texte client dans le socket) ; le frontend refetch les données autoritaires.
  AI_RUN_STARTED: 'ai.run.started',
  AI_RUN_COMPLETED: 'ai.run.completed',
  AI_RUN_FAILED: 'ai.run.failed',
  AI_SUGGESTION_CREATED: 'ai.suggestion.created',
  AI_HANDOFF_REQUESTED: 'ai.handoff.requested',
} as const;

/** Payload commun des événements IA : identifiants + statut, jamais de contenu. */
export interface AiRealtimeEvent {
  organizationId: string;
  shopId: string;
  conversationId: string;
  aiRunId: string;
  status?: string;
  suggestionId?: string;
  handoffId?: string;
}

/** Payload commun des événements Order : identifiants + version, rien d'autre. */
export interface OrderRealtimeEvent {
  organizationId: string;
  shopId: string;
  orderId: string;
  conversationId: string;
  orderVersion: number;
}

/** Payload commun des événements panier : identifiants + version, rien d'autre. */
export interface CartRealtimeEvent {
  organizationId: string;
  shopId: string;
  conversationId: string;
  cartId: string;
  cartVersion: number;
}

/** Événements client → serveur. */
export const SOCKET_CLIENT_EVENTS = {
  SUBSCRIBE_ORGANIZATION: 'subscribe:organization',
} as const;

/**
 * Rooms Socket.IO. V1 : seule la room organisation est utilisée (la sécurité
 * est au niveau org — tous les rôles ont conversations.read). Les rooms
 * shop/conversation sont réservées pour un fan-out plus fin ultérieur.
 * user:{userId} est jointe côté serveur uniquement (éviction ciblée).
 */
export function organizationRoom(organizationId: string): string {
  return `organization:${organizationId}`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** Longueur maximale d'un message texte WhatsApp. */
export const WHATSAPP_TEXT_MAX_LENGTH = 4096;

/** Fenêtre de service client Meta : 24 h après le dernier message entrant. */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
