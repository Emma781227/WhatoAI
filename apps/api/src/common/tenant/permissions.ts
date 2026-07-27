import type { MembershipRole } from '@whauto/database';

/**
 * Source unique de vérité du RBAC.
 * Les rôles ne sont JAMAIS lus depuis le frontend : ils viennent du Membership
 * vérifié en base par TenantGuard, puis traduits en permissions ici.
 */
export const PERMISSIONS = {
  ORGANIZATION_READ: 'organization.read',
  ORGANIZATION_UPDATE: 'organization.update',
  ORGANIZATION_ARCHIVE: 'organization.archive',
  /** Réservée — aucune route ne l'expose dans cette phase. */
  ORGANIZATION_DELETE: 'organization.delete',
  /** Réservée aux futurs paramètres sensibles (tokens Meta, paiement…). */
  SETTINGS_MANAGE: 'settings.manage',
  MEMBERS_READ: 'members.read',
  MEMBERS_INVITE: 'members.invite',
  MEMBERS_UPDATE_ROLE: 'members.updateRole',
  MEMBERS_REMOVE: 'members.remove',
  INVITATIONS_READ: 'invitations.read',
  INVITATIONS_CANCEL: 'invitations.cancel',
  SHOPS_READ: 'shops.read',
  SHOPS_CREATE: 'shops.create',
  SHOPS_UPDATE: 'shops.update',
  /** Couvre activate, deactivate et set-primary (changements structurels). */
  SHOPS_ACTIVATE: 'shops.activate',
  SHOPS_ARCHIVE: 'shops.archive',
  /** Paramètres opérationnels : horaires, politiques commerciales. */
  SHOPS_MANAGE_SETTINGS: 'shops.manageSettings',
  WHATSAPP_CHANNELS_READ: 'whatsappChannels.read',
  /** Connexion/déconnexion du canal — changement structurel (aligné sur shops.activate). */
  WHATSAPP_CHANNELS_MANAGE: 'whatsappChannels.manage',
  CONTACTS_READ: 'contacts.read',
  CONTACTS_UPDATE: 'contacts.update',
  /**
   * V1 (décision validée 2026-07-17) : les permissions conversations sont
   * PLATES — un AGENT lit et répond à TOUTES les conversations de
   * l'organisation, pas uniquement celles qui lui sont assignées. Le contrôle
   * par ressource (conversations assignées seulement) est explicitement
   * reporté : il exigerait un mécanisme de permissions par ressource qui
   * n'existe pas dans ce RBAC.
   */
  CONVERSATIONS_READ: 'conversations.read',
  CONVERSATIONS_REPLY: 'conversations.reply',
  CONVERSATIONS_ASSIGN: 'conversations.assign',
  CONVERSATIONS_UPDATE_STATUS: 'conversations.updateStatus',
  CONVERSATIONS_ADD_NOTE: 'conversations.addNote',
  CONVERSATIONS_MANAGE_TAGS: 'conversations.manageTags',
  CATEGORIES_READ: 'categories.read',
  CATEGORIES_CREATE: 'categories.create',
  CATEGORIES_UPDATE: 'categories.update',
  /** Structurel (aligné shops.archive) : OWNER/ADMIN uniquement. */
  CATEGORIES_ARCHIVE: 'categories.archive',
  PRODUCTS_READ: 'products.read',
  PRODUCTS_CREATE: 'products.create',
  PRODUCTS_UPDATE: 'products.update',
  /** Couvre activate ET deactivate (gestion quotidienne du catalogue). */
  PRODUCTS_ACTIVATE: 'products.activate',
  /** Structurel : OWNER/ADMIN uniquement. */
  PRODUCTS_ARCHIVE: 'products.archive',
  INVENTORY_READ: 'inventory.read',
  INVENTORY_ADJUST: 'inventory.adjust',
  /** Historique valorisé (coûts, casse) — plus sensible que le niveau de stock. */
  INVENTORY_VIEW_MOVEMENTS: 'inventory.viewMovements',
  CARTS_READ: 'carts.read',
  CARTS_CREATE: 'carts.create',
  CARTS_UPDATE: 'carts.update',
  CARTS_ABANDON: 'carts.abandon',
  CHECKOUT_READ: 'checkout.read',
  CHECKOUT_UPDATE: 'checkout.update',
  CHECKOUT_CONFIRM: 'checkout.confirm',
  /** Diagnostic technique des réservations — pas pour l'AGENT (il voit le résumé via le Cart). */
  STOCK_RESERVATIONS_READ: 'stockReservations.read',
  /** Réservée — AUCUNE route publique dans cette phase (réservations pilotées par le service). */
  STOCK_RESERVATIONS_MANAGE: 'stockReservations.manage',
  ORDERS_READ: 'orders.read',
  /** Conversion d'un checkout CONFIRMED en Order. */
  ORDERS_CREATE: 'orders.create',
  ORDERS_UPDATE_STATUS: 'orders.updateStatus',
  /** Annulation + restitution du stock — pas pour l'AGENT (validé D10). */
  ORDERS_CANCEL: 'orders.cancel',
  ORDERS_ADD_NOTE: 'orders.addNote',
  ORDERS_VIEW_HISTORY: 'orders.viewHistory',
  /** Réservée : aucun coût n'est snapshotté sur OrderItem dans cette phase. */
  ORDERS_VIEW_COST: 'orders.viewCost',
  /** Réservée — non implémentée dans cette phase. */
  ORDERS_EXPORT: 'orders.export',
  // IA conversationnelle (sous-phase B — SUGGEST_ONLY).
  AI_READ: 'ai.read',
  AI_CONFIGURE: 'ai.configure',
  /** Déclencher une génération manuelle de suggestion. */
  AI_SUGGEST: 'ai.suggest',
  AI_ACCEPT_SUGGESTION: 'ai.acceptSuggestion',
  AI_REJECT_SUGGESTION: 'ai.rejectSuggestion',
  /** Détails techniques des runs (tokens, outils) — plus sensible. */
  AI_VIEW_RUNS: 'ai.viewRuns',
  /** Réservée — AUTO_REPLY non activable fonctionnellement dans cette phase. */
  AI_ENABLE_AUTO_REPLY: 'ai.enableAutoReply',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const OWNER_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

const ADMIN_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.ORGANIZATION_READ,
  PERMISSIONS.ORGANIZATION_UPDATE,
  PERMISSIONS.MEMBERS_READ,
  PERMISSIONS.MEMBERS_INVITE,
  PERMISSIONS.MEMBERS_UPDATE_ROLE,
  PERMISSIONS.MEMBERS_REMOVE,
  PERMISSIONS.INVITATIONS_READ,
  PERMISSIONS.INVITATIONS_CANCEL,
  PERMISSIONS.SHOPS_READ,
  PERMISSIONS.SHOPS_CREATE,
  PERMISSIONS.SHOPS_UPDATE,
  PERMISSIONS.SHOPS_ACTIVATE,
  PERMISSIONS.SHOPS_ARCHIVE,
  PERMISSIONS.SHOPS_MANAGE_SETTINGS,
  PERMISSIONS.WHATSAPP_CHANNELS_READ,
  PERMISSIONS.WHATSAPP_CHANNELS_MANAGE,
  PERMISSIONS.CONTACTS_READ,
  PERMISSIONS.CONTACTS_UPDATE,
  PERMISSIONS.CONVERSATIONS_READ,
  PERMISSIONS.CONVERSATIONS_REPLY,
  PERMISSIONS.CONVERSATIONS_ASSIGN,
  PERMISSIONS.CONVERSATIONS_UPDATE_STATUS,
  PERMISSIONS.CONVERSATIONS_ADD_NOTE,
  PERMISSIONS.CONVERSATIONS_MANAGE_TAGS,
  PERMISSIONS.CATEGORIES_READ,
  PERMISSIONS.CATEGORIES_CREATE,
  PERMISSIONS.CATEGORIES_UPDATE,
  PERMISSIONS.CATEGORIES_ARCHIVE,
  PERMISSIONS.PRODUCTS_READ,
  PERMISSIONS.PRODUCTS_CREATE,
  PERMISSIONS.PRODUCTS_UPDATE,
  PERMISSIONS.PRODUCTS_ACTIVATE,
  PERMISSIONS.PRODUCTS_ARCHIVE,
  PERMISSIONS.INVENTORY_READ,
  PERMISSIONS.INVENTORY_ADJUST,
  PERMISSIONS.INVENTORY_VIEW_MOVEMENTS,
  PERMISSIONS.CARTS_READ,
  PERMISSIONS.CARTS_CREATE,
  PERMISSIONS.CARTS_UPDATE,
  PERMISSIONS.CARTS_ABANDON,
  PERMISSIONS.CHECKOUT_READ,
  PERMISSIONS.CHECKOUT_UPDATE,
  PERMISSIONS.CHECKOUT_CONFIRM,
  PERMISSIONS.STOCK_RESERVATIONS_READ,
  PERMISSIONS.STOCK_RESERVATIONS_MANAGE,
  PERMISSIONS.ORDERS_READ,
  PERMISSIONS.ORDERS_CREATE,
  PERMISSIONS.ORDERS_UPDATE_STATUS,
  PERMISSIONS.ORDERS_CANCEL,
  PERMISSIONS.ORDERS_ADD_NOTE,
  PERMISSIONS.ORDERS_VIEW_HISTORY,
  PERMISSIONS.ORDERS_VIEW_COST,
  PERMISSIONS.ORDERS_EXPORT,
  PERMISSIONS.AI_READ,
  PERMISSIONS.AI_CONFIGURE,
  PERMISSIONS.AI_SUGGEST,
  PERMISSIONS.AI_ACCEPT_SUGGESTION,
  PERMISSIONS.AI_REJECT_SUGGESTION,
  PERMISSIONS.AI_VIEW_RUNS,
  PERMISSIONS.AI_ENABLE_AUTO_REPLY,
];

const MANAGER_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.ORGANIZATION_READ,
  PERMISSIONS.MEMBERS_READ,
  PERMISSIONS.SHOPS_READ,
  PERMISSIONS.SHOPS_UPDATE,
  PERMISSIONS.SHOPS_MANAGE_SETTINGS,
  // Le MANAGER voit l'état du canal (nécessaire à l'inbox) mais ne peut pas
  // le connecter/déconnecter (whatsappChannels.manage = OWNER/ADMIN).
  PERMISSIONS.WHATSAPP_CHANNELS_READ,
  PERMISSIONS.CONTACTS_READ,
  PERMISSIONS.CONTACTS_UPDATE,
  PERMISSIONS.CONVERSATIONS_READ,
  PERMISSIONS.CONVERSATIONS_REPLY,
  PERMISSIONS.CONVERSATIONS_ASSIGN,
  PERMISSIONS.CONVERSATIONS_UPDATE_STATUS,
  PERMISSIONS.CONVERSATIONS_ADD_NOTE,
  PERMISSIONS.CONVERSATIONS_MANAGE_TAGS,
  // Catalogue : le MANAGER gère le quotidien (création, prix, activation,
  // stock) mais jamais l'archivage (structurel, OWNER/ADMIN).
  PERMISSIONS.CATEGORIES_READ,
  PERMISSIONS.CATEGORIES_CREATE,
  PERMISSIONS.CATEGORIES_UPDATE,
  PERMISSIONS.PRODUCTS_READ,
  PERMISSIONS.PRODUCTS_CREATE,
  PERMISSIONS.PRODUCTS_UPDATE,
  PERMISSIONS.PRODUCTS_ACTIVATE,
  PERMISSIONS.INVENTORY_READ,
  PERMISSIONS.INVENTORY_ADJUST,
  PERMISSIONS.INVENTORY_VIEW_MOVEMENTS,
  // Panier : opérations quotidiennes complètes + diagnostic des réservations
  // (jamais stockReservations.manage — outil technique OWNER/ADMIN, sans
  // route publique dans cette phase).
  PERMISSIONS.CARTS_READ,
  PERMISSIONS.CARTS_CREATE,
  PERMISSIONS.CARTS_UPDATE,
  PERMISSIONS.CARTS_ABANDON,
  PERMISSIONS.CHECKOUT_READ,
  PERMISSIONS.CHECKOUT_UPDATE,
  PERMISSIONS.CHECKOUT_CONFIRM,
  PERMISSIONS.STOCK_RESERVATIONS_READ,
  // Orders : gestion quotidienne complète, annulation incluse (avant SHIPPED
  // — la règle vit dans le service de transition, pas ici).
  PERMISSIONS.ORDERS_READ,
  PERMISSIONS.ORDERS_CREATE,
  PERMISSIONS.ORDERS_UPDATE_STATUS,
  PERMISSIONS.ORDERS_CANCEL,
  PERMISSIONS.ORDERS_ADD_NOTE,
  PERMISSIONS.ORDERS_VIEW_HISTORY,
  PERMISSIONS.ORDERS_VIEW_COST,
  // IA : le MANAGER gère la configuration quotidienne et voit les runs, mais
  // n'active JAMAIS AUTO_REPLY (structurel — OWNER/ADMIN).
  PERMISSIONS.AI_READ,
  PERMISSIONS.AI_CONFIGURE,
  PERMISSIONS.AI_SUGGEST,
  PERMISSIONS.AI_ACCEPT_SUGGESTION,
  PERMISSIONS.AI_REJECT_SUGGESTION,
  PERMISSIONS.AI_VIEW_RUNS,
];

// AGENT : lit et répond à toutes les conversations de l'org (matrice plate
// V1), change les statuts (résoudre fait partie du travail quotidien), mais
// n'assigne pas, ne gère pas les tags, ne modifie pas les contacts.
const AGENT_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.ORGANIZATION_READ,
  PERMISSIONS.SHOPS_READ,
  PERMISSIONS.WHATSAPP_CHANNELS_READ,
  PERMISSIONS.CONTACTS_READ,
  PERMISSIONS.CONVERSATIONS_READ,
  PERMISSIONS.CONVERSATIONS_REPLY,
  PERMISSIONS.CONVERSATIONS_UPDATE_STATUS,
  PERMISSIONS.CONVERSATIONS_ADD_NOTE,
  // Catalogue en lecture seule (nécessaire au sélecteur produit de l'inbox).
  // costPriceMinor n'est JAMAIS exposé à l'AGENT (DTO dédiés côté service).
  PERMISSIONS.CATEGORIES_READ,
  PERMISSIONS.PRODUCTS_READ,
  PERMISSIONS.INVENTORY_READ,
  // Parcours commercial COMPLET (validé) : panier, checkout, abandon,
  // confirmation — c'est le métier quotidien de l'agent. Il voit le résumé de
  // réservation via la réponse Cart, jamais le diagnostic technique
  // (stockReservations.read = MANAGER+).
  PERMISSIONS.CARTS_READ,
  PERMISSIONS.CARTS_CREATE,
  PERMISSIONS.CARTS_UPDATE,
  PERMISSIONS.CARTS_ABANDON,
  PERMISSIONS.CHECKOUT_READ,
  PERMISSIONS.CHECKOUT_UPDATE,
  PERMISSIONS.CHECKOUT_CONFIRM,
  // Orders : conversion + statuts opérationnels + notes — mais JAMAIS
  // l'annulation (orders.cancel = MANAGER+, validé D10) ni les coûts.
  PERMISSIONS.ORDERS_READ,
  PERMISSIONS.ORDERS_CREATE,
  PERMISSIONS.ORDERS_UPDATE_STATUS,
  PERMISSIONS.ORDERS_ADD_NOTE,
  PERMISSIONS.ORDERS_VIEW_HISTORY,
  // IA : l'AGENT voit les suggestions, en génère, accepte/modifie/rejette —
  // c'est son métier. Jamais la configuration ni les détails techniques des
  // runs (ai.viewRuns = MANAGER+), jamais AUTO_REPLY.
  PERMISSIONS.AI_READ,
  PERMISSIONS.AI_SUGGEST,
  PERMISSIONS.AI_ACCEPT_SUGGESTION,
  PERMISSIONS.AI_REJECT_SUGGESTION,
];

export const ROLE_PERMISSIONS: Readonly<Record<MembershipRole, readonly Permission[]>> = {
  OWNER: OWNER_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  MANAGER: MANAGER_PERMISSIONS,
  AGENT: AGENT_PERMISSIONS,
};

/**
 * Poids hiérarchiques : un acteur ne peut assigner, modifier ou retirer que
 * des rôles STRICTEMENT inférieurs au sien. Conséquences (validées) :
 * - personne ne touche un OWNER via les routes standards ;
 * - un ADMIN ne gère pas un autre ADMIN et ne peut pas inviter/assigner ADMIN ;
 * - auto-promotion impossible par construction.
 */
export const ROLE_WEIGHT: Readonly<Record<MembershipRole, number>> = {
  OWNER: 4,
  ADMIN: 3,
  MANAGER: 2,
  AGENT: 1,
};

export function hasPermission(role: MembershipRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** L'acteur peut-il agir sur un membre portant `targetRole` ? */
export function canActOnRole(actorRole: MembershipRole, targetRole: MembershipRole): boolean {
  return ROLE_WEIGHT[actorRole] > ROLE_WEIGHT[targetRole];
}

/** L'acteur peut-il attribuer `roleToAssign` (invitation ou changement de rôle) ? */
export function canAssignRole(actorRole: MembershipRole, roleToAssign: MembershipRole): boolean {
  return ROLE_WEIGHT[actorRole] > ROLE_WEIGHT[roleToAssign];
}
