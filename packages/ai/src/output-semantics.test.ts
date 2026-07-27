import { describe, expect, it } from 'vitest';

import { evaluateAiOutputSemantics } from './output-semantics';
import type { AiStructuredOutput } from './structured-output';

function suggest(replyText: string, usedBusinessData = true): AiStructuredOutput {
  return { action: 'SUGGEST_REPLY', replyText, handoffReason: null, confidence: 0.8, usedBusinessData };
}
function handoff(handoffReason: string, replyText: string | null = null): AiStructuredOutput {
  return { action: 'HANDOFF', replyText, handoffReason, confidence: 0.5, usedBusinessData: false };
}

describe('evaluateAiOutputSemantics — annonce de transfert humain (règles 1 & 4)', () => {
  it('FR : le cas réel observé au test Gemini → FORCE_HANDOFF', () => {
    const verdict = evaluateAiOutputSemantics(
      suggest('Bonjour ! Je vous mets en relation avec un conseiller pour vous répondre.', false),
    );
    expect(verdict.decision).toBe('FORCE_HANDOFF');
    expect(verdict.issue).toBe('SUGGEST_ANNOUNCES_HANDOFF');
  });

  it.each([
    'Je transfère votre demande à un collègue.',
    'Un membre de notre équipe va vous répondre.',
    'Je vous oriente vers un responsable.',
    'Un humain va prendre le relais.',
  ])('FR : "%s" → FORCE_HANDOFF', (text) => {
    expect(evaluateAiOutputSemantics(suggest(text)).decision).toBe('FORCE_HANDOFF');
  });

  it.each([
    'Let me connect you with a human agent.',
    "I'll put you in touch with one of our representatives.",
    'Our team will get back to you shortly.',
    'I will transfer you to a colleague.',
  ])('EN : "%s" → FORCE_HANDOFF', (text) => {
    expect(evaluateAiOutputSemantics(suggest(text)).decision).toBe('FORCE_HANDOFF');
  });

  it('ne confond pas « je vous conseille » (verbe) avec « un conseiller » (humain)', () => {
    expect(evaluateAiOutputSemantics(suggest('Je vous conseille ce modèle rouge.')).decision).toBe(
      'CONSISTENT',
    );
  });
});

describe('evaluateAiOutputSemantics — affirmation métier non vérifiée (règle 3)', () => {
  it.each([
    'Ce sac coûte 15000 FCFA.',
    'Oui, il est en stock.',
    'Nous sommes ouverts le dimanche de 9h à 18h.',
    'Votre commande a été expédiée hier.',
  ])('FR : "%s" sans usedBusinessData → FORCE_HANDOFF', (text) => {
    const verdict = evaluateAiOutputSemantics(suggest(text, false));
    expect(verdict.decision).toBe('FORCE_HANDOFF');
    expect(verdict.issue).toBe('UNVERIFIED_BUSINESS_CLAIM');
  });

  it.each([
    'It costs 20 EUR.',
    'Yes, it is available.',
    "We're open on Sundays.",
    'Your order has been shipped.',
  ])('EN : "%s" sans usedBusinessData → FORCE_HANDOFF', (text) => {
    expect(evaluateAiOutputSemantics(suggest(text, false)).decision).toBe('FORCE_HANDOFF');
  });

  it('même affirmation AVEC usedBusinessData=true → cohérente (outil a vérifié)', () => {
    expect(evaluateAiOutputSemantics(suggest('Ce sac coûte 15000 FCFA.', true)).decision).toBe(
      'CONSISTENT',
    );
  });

  it('question de clarification sans affirmation → cohérente', () => {
    expect(
      evaluateAiOutputSemantics(suggest('Quel produit vous intéresse pour que je vérifie ?', false))
        .decision,
    ).toBe('CONSISTENT');
    expect(
      evaluateAiOutputSemantics(suggest('Which product are you interested in?', false)).decision,
    ).toBe('CONSISTENT');
  });
});

describe('evaluateAiOutputSemantics — cohérence des HANDOFF (règle 2)', () => {
  it('HANDOFF avec raison, sans réponse → cohérent', () => {
    expect(evaluateAiOutputSemantics(handoff('Demande de remboursement.')).decision).toBe(
      'CONSISTENT',
    );
  });

  it('HANDOFF sans raison → INVALID_OUTPUT', () => {
    expect(evaluateAiOutputSemantics(handoff('   ')).decision).toBe('INVALID_OUTPUT');
  });

  it('HANDOFF portant une réponse commerciale affirmative → INVALID_OUTPUT', () => {
    const verdict = evaluateAiOutputSemantics(
      handoff('Litige', 'Oui, le produit est en stock à 5000 FCFA.'),
    );
    expect(verdict.decision).toBe('INVALID_OUTPUT');
    expect(verdict.issue).toBe('HANDOFF_WITH_AFFIRMATIVE_REPLY');
  });
});

describe('evaluateAiOutputSemantics — cas cohérents', () => {
  it('SUGGEST_REPLY neutre → cohérent', () => {
    expect(evaluateAiOutputSemantics(suggest('Bonjour, avec plaisir ! Que cherchez-vous ?', false)).decision).toBe(
      'CONSISTENT',
    );
  });

  it('NO_REPLY → toujours cohérent', () => {
    expect(
      evaluateAiOutputSemantics({
        action: 'NO_REPLY',
        replyText: null,
        handoffReason: null,
        confidence: 0.1,
        usedBusinessData: false,
      }).decision,
    ).toBe('CONSISTENT');
  });
});
