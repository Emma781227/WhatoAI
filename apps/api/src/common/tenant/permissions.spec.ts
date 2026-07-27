import type { MembershipRole } from '@whauto/database';

import {
  canActOnRole,
  canAssignRole,
  hasPermission,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_WEIGHT,
} from './permissions';

const ALL_ROLES: MembershipRole[] = ['OWNER', 'ADMIN', 'MANAGER', 'AGENT'];

describe('permissions', () => {
  it('OWNER possède toutes les permissions', () => {
    for (const permission of Object.values(PERMISSIONS)) {
      expect(hasPermission('OWNER', permission)).toBe(true);
    }
  });

  it('matrice ADMIN : gestion quotidienne sans archive/delete/settings', () => {
    expect(hasPermission('ADMIN', PERMISSIONS.ORGANIZATION_UPDATE)).toBe(true);
    expect(hasPermission('ADMIN', PERMISSIONS.MEMBERS_INVITE)).toBe(true);
    expect(hasPermission('ADMIN', PERMISSIONS.MEMBERS_UPDATE_ROLE)).toBe(true);
    expect(hasPermission('ADMIN', PERMISSIONS.MEMBERS_REMOVE)).toBe(true);
    expect(hasPermission('ADMIN', PERMISSIONS.INVITATIONS_CANCEL)).toBe(true);
    expect(hasPermission('ADMIN', PERMISSIONS.ORGANIZATION_ARCHIVE)).toBe(false);
    expect(hasPermission('ADMIN', PERMISSIONS.ORGANIZATION_DELETE)).toBe(false);
    expect(hasPermission('ADMIN', PERMISSIONS.SETTINGS_MANAGE)).toBe(false);
  });

  it('matrice MANAGER : lectures + gestion opérationnelle, jamais de structurel', () => {
    expect(ROLE_PERMISSIONS.MANAGER).toEqual([
      PERMISSIONS.ORGANIZATION_READ,
      PERMISSIONS.MEMBERS_READ,
      PERMISSIONS.SHOPS_READ,
      PERMISSIONS.SHOPS_UPDATE,
      PERMISSIONS.SHOPS_MANAGE_SETTINGS,
      PERMISSIONS.WHATSAPP_CHANNELS_READ,
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
      PERMISSIONS.PRODUCTS_READ,
      PERMISSIONS.PRODUCTS_CREATE,
      PERMISSIONS.PRODUCTS_UPDATE,
      PERMISSIONS.PRODUCTS_ACTIVATE,
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
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.ORDERS_CREATE,
      PERMISSIONS.ORDERS_UPDATE_STATUS,
      PERMISSIONS.ORDERS_CANCEL,
      PERMISSIONS.ORDERS_ADD_NOTE,
      PERMISSIONS.ORDERS_VIEW_HISTORY,
      PERMISSIONS.ORDERS_VIEW_COST,
    ]);
  });

  it('matrice AGENT : conversations + catalogue lecture + parcours panier/checkout/orders complet (V1 validée)', () => {
    expect(ROLE_PERMISSIONS.AGENT).toEqual([
      PERMISSIONS.ORGANIZATION_READ,
      PERMISSIONS.SHOPS_READ,
      PERMISSIONS.WHATSAPP_CHANNELS_READ,
      PERMISSIONS.CONTACTS_READ,
      PERMISSIONS.CONVERSATIONS_READ,
      PERMISSIONS.CONVERSATIONS_REPLY,
      PERMISSIONS.CONVERSATIONS_UPDATE_STATUS,
      PERMISSIONS.CONVERSATIONS_ADD_NOTE,
      PERMISSIONS.CATEGORIES_READ,
      PERMISSIONS.PRODUCTS_READ,
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.CARTS_READ,
      PERMISSIONS.CARTS_CREATE,
      PERMISSIONS.CARTS_UPDATE,
      PERMISSIONS.CARTS_ABANDON,
      PERMISSIONS.CHECKOUT_READ,
      PERMISSIONS.CHECKOUT_UPDATE,
      PERMISSIONS.CHECKOUT_CONFIRM,
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.ORDERS_CREATE,
      PERMISSIONS.ORDERS_UPDATE_STATUS,
      PERMISSIONS.ORDERS_ADD_NOTE,
      PERMISSIONS.ORDERS_VIEW_HISTORY,
    ]);
  });

  it('AGENT n’a jamais orders.cancel ni orders.export (validé D10)', () => {
    expect(hasPermission('AGENT', PERMISSIONS.ORDERS_CANCEL)).toBe(false);
    expect(hasPermission('AGENT', PERMISSIONS.ORDERS_EXPORT)).toBe(false);
    expect(hasPermission('MANAGER', PERMISSIONS.ORDERS_CANCEL)).toBe(true);
  });

  it('réservations : diagnostic MANAGER+, outil technique OWNER/ADMIN, AGENT sans accès', () => {
    expect(hasPermission('MANAGER', PERMISSIONS.STOCK_RESERVATIONS_READ)).toBe(true);
    expect(hasPermission('AGENT', PERMISSIONS.STOCK_RESERVATIONS_READ)).toBe(false);
    expect(hasPermission('MANAGER', PERMISSIONS.STOCK_RESERVATIONS_MANAGE)).toBe(false);
    expect(hasPermission('AGENT', PERMISSIONS.STOCK_RESERVATIONS_MANAGE)).toBe(false);
    expect(hasPermission('ADMIN', PERMISSIONS.STOCK_RESERVATIONS_MANAGE)).toBe(true);
    for (const role of ALL_ROLES) {
      expect(hasPermission(role, PERMISSIONS.CARTS_UPDATE)).toBe(true);
      expect(hasPermission(role, PERMISSIONS.CHECKOUT_CONFIRM)).toBe(true);
    }
  });

  it('catalogue : archives réservées à OWNER/ADMIN, MANAGER gère le quotidien, AGENT lecture seule', () => {
    for (const permission of [PERMISSIONS.CATEGORIES_ARCHIVE, PERMISSIONS.PRODUCTS_ARCHIVE]) {
      expect(hasPermission('OWNER', permission)).toBe(true);
      expect(hasPermission('ADMIN', permission)).toBe(true);
      expect(hasPermission('MANAGER', permission)).toBe(false);
      expect(hasPermission('AGENT', permission)).toBe(false);
    }
    for (const permission of [
      PERMISSIONS.PRODUCTS_CREATE,
      PERMISSIONS.PRODUCTS_UPDATE,
      PERMISSIONS.PRODUCTS_ACTIVATE,
      PERMISSIONS.INVENTORY_ADJUST,
      PERMISSIONS.INVENTORY_VIEW_MOVEMENTS,
    ]) {
      expect(hasPermission('MANAGER', permission)).toBe(true);
      expect(hasPermission('AGENT', permission)).toBe(false);
    }
    for (const role of ALL_ROLES) {
      expect(hasPermission(role, PERMISSIONS.PRODUCTS_READ)).toBe(true);
      expect(hasPermission(role, PERMISSIONS.CATEGORIES_READ)).toBe(true);
      expect(hasPermission(role, PERMISSIONS.INVENTORY_READ)).toBe(true);
    }
  });

  it('whatsappChannels.manage réservé à OWNER et ADMIN', () => {
    expect(hasPermission('OWNER', PERMISSIONS.WHATSAPP_CHANNELS_MANAGE)).toBe(true);
    expect(hasPermission('ADMIN', PERMISSIONS.WHATSAPP_CHANNELS_MANAGE)).toBe(true);
    expect(hasPermission('MANAGER', PERMISSIONS.WHATSAPP_CHANNELS_MANAGE)).toBe(false);
    expect(hasPermission('AGENT', PERMISSIONS.WHATSAPP_CHANNELS_MANAGE)).toBe(false);
  });

  it('AGENT : jamais assign, manageTags ni contacts.update', () => {
    expect(hasPermission('AGENT', PERMISSIONS.CONVERSATIONS_ASSIGN)).toBe(false);
    expect(hasPermission('AGENT', PERMISSIONS.CONVERSATIONS_MANAGE_TAGS)).toBe(false);
    expect(hasPermission('AGENT', PERMISSIONS.CONTACTS_UPDATE)).toBe(false);
  });

  it('tous les rôles peuvent lire et répondre aux conversations', () => {
    for (const role of ALL_ROLES) {
      expect(hasPermission(role, PERMISSIONS.CONVERSATIONS_READ)).toBe(true);
      expect(hasPermission(role, PERMISSIONS.CONVERSATIONS_REPLY)).toBe(true);
      expect(hasPermission(role, PERMISSIONS.CONVERSATIONS_ADD_NOTE)).toBe(true);
    }
  });

  it('matrice shops : create/activate/archive réservés à OWNER et ADMIN', () => {
    for (const permission of [
      PERMISSIONS.SHOPS_CREATE,
      PERMISSIONS.SHOPS_ACTIVATE,
      PERMISSIONS.SHOPS_ARCHIVE,
    ]) {
      expect(hasPermission('OWNER', permission)).toBe(true);
      expect(hasPermission('ADMIN', permission)).toBe(true);
      expect(hasPermission('MANAGER', permission)).toBe(false);
      expect(hasPermission('AGENT', permission)).toBe(false);
    }
  });

  it('tous les rôles ont organization.read', () => {
    for (const role of ALL_ROLES) {
      expect(hasPermission(role, PERMISSIONS.ORGANIZATION_READ)).toBe(true);
    }
  });

  describe('hiérarchie stricte', () => {
    it('un acteur agit uniquement sur des rôles strictement inférieurs', () => {
      expect(canActOnRole('OWNER', 'ADMIN')).toBe(true);
      expect(canActOnRole('OWNER', 'AGENT')).toBe(true);
      expect(canActOnRole('ADMIN', 'MANAGER')).toBe(true);
      expect(canActOnRole('ADMIN', 'AGENT')).toBe(true);

      // Personne n'agit sur un OWNER, ni sur un égal.
      for (const role of ALL_ROLES) {
        expect(canActOnRole(role, 'OWNER')).toBe(false);
        expect(canActOnRole(role, role)).toBe(false);
      }
      expect(canActOnRole('ADMIN', 'ADMIN')).toBe(false);
      expect(canActOnRole('AGENT', 'MANAGER')).toBe(false);
    });

    it("un acteur n'assigne que des rôles strictement inférieurs", () => {
      expect(canAssignRole('OWNER', 'ADMIN')).toBe(true);
      expect(canAssignRole('ADMIN', 'MANAGER')).toBe(true);
      expect(canAssignRole('ADMIN', 'ADMIN')).toBe(false);
      expect(canAssignRole('MANAGER', 'AGENT')).toBe(true);
      for (const role of ALL_ROLES) {
        expect(canAssignRole(role, 'OWNER')).toBe(false);
      }
    });

    it('les poids sont strictement ordonnés', () => {
      expect(ROLE_WEIGHT.OWNER).toBeGreaterThan(ROLE_WEIGHT.ADMIN);
      expect(ROLE_WEIGHT.ADMIN).toBeGreaterThan(ROLE_WEIGHT.MANAGER);
      expect(ROLE_WEIGHT.MANAGER).toBeGreaterThan(ROLE_WEIGHT.AGENT);
    });
  });
});
