import { describe, expect, it } from 'vitest';

import { assembleContext, estimateMessagesTokens, estimateTokens } from './context-budget';
import type { AiInputMessage } from './types';

function msg(role: AiInputMessage['role'], content: string): AiInputMessage {
  return { role, content };
}

/** ~4 caractères par token : 400 caractères ≈ 101 tokens estimés. */
function longText(chars: number): string {
  return 'a'.repeat(chars);
}

describe('estimateTokens', () => {
  it('déterministe et pessimiste (jamais 0 pour un texte non vide)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(estimateTokens('abcd'));
    expect(estimateTokens('a')).toBeGreaterThan(0);
    expect(estimateTokens(longText(400))).toBe(101);
  });

  it('somme les messages', () => {
    expect(estimateMessagesTokens([msg('CUSTOMER', 'abcd'), msg('AGENT', 'abcd')])).toBe(
      estimateTokens('abcd') * 2,
    );
  });
});

describe('assembleContext', () => {
  const facts = ['Devise : XAF', 'Fuseau : Africa/Douala'];

  it('garde tout quand le budget est large', () => {
    const result = assembleContext(
      {
        shopFacts: facts,
        businessRules: 'Pas de retour après 7 jours.',
        conversationSummary: 'Le client cherche une robe.',
        messages: [msg('CUSTOMER', 'bonjour'), msg('AGENT', 'bonjour !')],
      },
      10000,
    );
    expect(result.messages).toHaveLength(2);
    expect(result.businessRules).not.toBeNull();
    expect(result.conversationSummary).not.toBeNull();
    expect(result.droppedMessageCount).toBe(0);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('sacrifie les messages les PLUS ANCIENS et rapporte la coupe', () => {
    const messages = [
      msg('CUSTOMER', longText(400)), // le plus ancien
      msg('AGENT', longText(400)),
      msg('CUSTOMER', longText(400)), // le plus récent (déclencheur)
    ];
    const result = assembleContext({ shopFacts: [], messages }, 210);

    expect(result.droppedMessageCount).toBe(1);
    expect(result.messages).toHaveLength(2);
    // L'ordre chronologique est préservé, et le déclencheur est le dernier.
    expect(result.messages[result.messages.length - 1]).toBe(messages[2]);
    expect(result.messages[0]).toBe(messages[1]);
  });

  it('ne sacrifie JAMAIS le dernier message, même s’il dépasse à lui seul le budget', () => {
    const messages = [msg('CUSTOMER', longText(400)), msg('CUSTOMER', longText(4000))];
    const result = assembleContext({ shopFacts: [], messages }, 50);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toBe(messages[1]);
    expect(result.droppedMessageCount).toBe(1);
    // Le dépassement est assumé et VISIBLE (jamais masqué).
    expect(result.estimatedTokens).toBeGreaterThan(50);
  });

  it('abandonne le résumé avant les messages quand le budget est saturé', () => {
    const result = assembleContext(
      {
        shopFacts: [],
        conversationSummary: longText(4000),
        messages: [msg('CUSTOMER', 'ma question')],
      },
      60,
    );
    expect(result.droppedSummary).toBe(true);
    expect(result.conversationSummary).toBeNull();
    expect(result.messages).toHaveLength(1);
  });

  it('abandonne les règles boutique trop lourdes sans toucher au reste', () => {
    const result = assembleContext(
      {
        shopFacts: [],
        businessRules: longText(4000),
        conversationSummary: 'court résumé',
        messages: [msg('CUSTOMER', 'ma question')],
      },
      100,
    );
    expect(result.droppedBusinessRules).toBe(true);
    expect(result.businessRules).toBeNull();
    expect(result.conversationSummary).toBe('court résumé');
  });

  it('budget <= 0 = aucun budget : rien n’est tronqué', () => {
    const messages = [msg('CUSTOMER', longText(4000)), msg('AGENT', longText(4000))];
    const result = assembleContext({ shopFacts: facts, messages }, 0);
    expect(result.messages).toHaveLength(2);
    expect(result.droppedMessageCount).toBe(0);
  });

  it('normalise les chaînes vides en null (jamais un bloc vide envoyé au modèle)', () => {
    const result = assembleContext(
      { shopFacts: [], businessRules: '   ', conversationSummary: '', messages: [] },
      1000,
    );
    expect(result.businessRules).toBeNull();
    expect(result.conversationSummary).toBeNull();
    expect(result.droppedBusinessRules).toBe(false);
    expect(result.droppedSummary).toBe(false);
  });
});
