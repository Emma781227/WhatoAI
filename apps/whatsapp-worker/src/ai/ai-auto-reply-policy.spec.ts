import {
  AUTO_REPLY_MIN_CONFIDENCE,
  evaluateAutoReplyGate,
  type AutoReplyGateInput,
} from './ai-auto-reply-policy';

/** Entrée « tout vert » : chaque test dégrade UN seul critère. */
function baseInput(): AutoReplyGateInput {
  return {
    conversationPaused: false,
    allowedCategories: ['PRODUCT_INFO', 'AVAILABILITY', 'OPENING_HOURS', 'ORDER_STATUS'],
    usedToolNames: ['search_products', 'get_product_details'],
    confidence: 0.9,
    windowOpen: true,
    scheduleMode: 'ALWAYS',
    isOpenNow: true,
    autoRepliesSinceLastInbound: 0,
    autoRepliesLast24h: 0,
    maxPerConversationPerDay: 5,
  };
}

describe('evaluateAutoReplyGate', () => {
  it('ENVOIE quand tous les feux sont verts', () => {
    expect(evaluateAutoReplyGate(baseInput())).toEqual({ action: 'SEND' });
  });

  it('ENVOIE une réponse sans outil (aucune donnée métier, aucune catégorie à vérifier)', () => {
    expect(evaluateAutoReplyGate({ ...baseInput(), usedToolNames: [] })).toEqual({ action: 'SEND' });
  });

  it('SUPPRESS CONVERSATION_PAUSED quand un humain a repris/mis en pause', () => {
    expect(evaluateAutoReplyGate({ ...baseInput(), conversationPaused: true })).toEqual({
      action: 'SUPPRESS',
      reason: 'CONVERSATION_PAUSED',
    });
  });

  it('CONVERSATION_PAUSED prime sur tous les autres blocages', () => {
    expect(
      evaluateAutoReplyGate({
        ...baseInput(),
        conversationPaused: true,
        windowOpen: false,
        confidence: 0.1,
      }),
    ).toEqual({ action: 'SUPPRESS', reason: 'CONVERSATION_PAUSED' });
  });

  it('SUPPRESS WINDOW_CLOSED quand la fenêtre 24 h est fermée', () => {
    expect(evaluateAutoReplyGate({ ...baseInput(), windowOpen: false })).toEqual({
      action: 'SUPPRESS',
      reason: 'WINDOW_CLOSED',
    });
  });

  it('SUPPRESS OUTSIDE_BUSINESS_HOURS en mode hors-ouverture quand la boutique est ouverte', () => {
    expect(
      evaluateAutoReplyGate({
        ...baseInput(),
        scheduleMode: 'OUTSIDE_BUSINESS_HOURS',
        isOpenNow: true,
      }),
    ).toEqual({ action: 'SUPPRESS', reason: 'OUTSIDE_BUSINESS_HOURS' });
  });

  it('ENVOIE en mode hors-ouverture quand la boutique est fermée', () => {
    expect(
      evaluateAutoReplyGate({
        ...baseInput(),
        scheduleMode: 'OUTSIDE_BUSINESS_HOURS',
        isOpenNow: false,
      }),
    ).toEqual({ action: 'SEND' });
  });

  it('SUPPRESS CATEGORY_NOT_ALLOWED si un outil utilisé est hors liste blanche', () => {
    expect(
      evaluateAutoReplyGate({
        ...baseInput(),
        usedToolNames: ['search_products', 'get_order_status'],
        allowedCategories: ['PRODUCT_INFO'], // ORDER_STATUS retiré.
      }),
    ).toEqual({ action: 'SUPPRESS', reason: 'CATEGORY_NOT_ALLOWED' });
  });

  it('SUPPRESS CATEGORY_NOT_ALLOWED pour un outil inconnu (handoff, jamais une catégorie de réponse)', () => {
    expect(
      evaluateAutoReplyGate({ ...baseInput(), usedToolNames: ['request_human_handoff'] }),
    ).toEqual({ action: 'SUPPRESS', reason: 'CATEGORY_NOT_ALLOWED' });
  });

  it('SUPPRESS ANTI_MONOLOGUE si une réponse auto a déjà suivi le dernier message client', () => {
    expect(
      evaluateAutoReplyGate({ ...baseInput(), autoRepliesSinceLastInbound: 1 }),
    ).toEqual({ action: 'SUPPRESS', reason: 'ANTI_MONOLOGUE' });
  });

  it('SUPPRESS RATE_LIMIT au plafond journalier', () => {
    expect(
      evaluateAutoReplyGate({ ...baseInput(), autoRepliesLast24h: 5, maxPerConversationPerDay: 5 }),
    ).toEqual({ action: 'SUPPRESS', reason: 'RATE_LIMIT' });
  });

  it('SUPPRESS LOW_CONFIDENCE sous le plancher', () => {
    expect(
      evaluateAutoReplyGate({ ...baseInput(), confidence: AUTO_REPLY_MIN_CONFIDENCE - 0.01 }),
    ).toEqual({ action: 'SUPPRESS', reason: 'LOW_CONFIDENCE' });
  });

  it('ENVOIE exactement au plancher de confiance', () => {
    expect(
      evaluateAutoReplyGate({ ...baseInput(), confidence: AUTO_REPLY_MIN_CONFIDENCE }),
    ).toEqual({ action: 'SEND' });
  });

  it('priorité : la fenêtre fermée prime sur les autres blocages', () => {
    expect(
      evaluateAutoReplyGate({
        ...baseInput(),
        windowOpen: false,
        confidence: 0.1,
        autoRepliesLast24h: 99,
      }),
    ).toEqual({ action: 'SUPPRESS', reason: 'WINDOW_CLOSED' });
  });
});
