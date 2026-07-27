/**
 * Textes structurants centralisés (pré-i18n) : navigation, actions communes,
 * intitulés d'entités. Les libellés très locaux restent dans leurs composants ;
 * tout ce qui devra être traduit en premier est ici.
 */
export const messages = {
  app: { name: 'Whauto AI', tagline: 'Commerce conversationnel WhatsApp Business' },
  nav: {
    dashboard: 'Tableau de bord',
    conversations: 'Conversations',
    contacts: 'Contacts',
    products: 'Produits',
    orders: 'Commandes',
    automations: 'Automatisations',
    aiAgent: 'Agent IA',
    shops: 'Boutiques',
    members: 'Membres',
    settings: 'Paramètres',
    comingSoon: 'Bientôt',
  },
  actions: {
    save: 'Enregistrer',
    create: 'Créer',
    cancel: 'Annuler',
    confirm: 'Confirmer',
    retry: 'Réessayer',
    delete: 'Supprimer',
    archive: 'Archiver',
    edit: 'Modifier',
    search: 'Rechercher',
    logout: 'Se déconnecter',
    login: 'Se connecter',
    register: 'Créer un compte',
  },
  roles: {
    OWNER: 'Propriétaire',
    ADMIN: 'Administrateur',
    MANAGER: 'Manager',
    AGENT: 'Agent',
  } as Record<string, string>,
  shopStatus: {
    DRAFT: 'Brouillon',
    ACTIVE: 'Active',
    INACTIVE: 'Inactive',
    ARCHIVED: 'Archivée',
  } as Record<string, string>,
  invitationStatus: {
    PENDING: 'En attente',
    ACCEPTED: 'Acceptée',
    DECLINED: 'Refusée',
    CANCELLED: 'Annulée',
    EXPIRED: 'Expirée',
  } as Record<string, string>,
} as const;
