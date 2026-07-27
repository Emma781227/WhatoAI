import { describe, expect, it } from 'vitest';

import { AiProviderError } from './errors';
import { parseAiStructuredOutput } from './structured-output';

function output(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'SUGGEST_REPLY',
    replyText: 'Bonjour, oui ce produit est disponible.',
    handoffReason: null,
    confidence: 0.8,
    usedBusinessData: true,
    ...overrides,
  });
}

function expectInvalid(text: string | null, code: string): void {
  try {
    parseAiStructuredOutput(text);
    throw new Error('aurait dû lever');
  } catch (error) {
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe(code);
    expect((error as AiProviderError).errorClass).toBe('INVALID_OUTPUT');
  }
}

describe('parseAiStructuredOutput', () => {
  it('accepte une sortie conforme', () => {
    const parsed = parseAiStructuredOutput(output());
    expect(parsed.action).toBe('SUGGEST_REPLY');
    expect(parsed.usedBusinessData).toBe(true);
  });

  it('tolère une clôture Markdown autour du JSON', () => {
    const parsed = parseAiStructuredOutput('```json\n' + output() + '\n```');
    expect(parsed.action).toBe('SUGGEST_REPLY');
  });

  it('refuse une réponse vide ou nulle', () => {
    expectInvalid(null, 'AI_EMPTY_OUTPUT');
    expectInvalid('   ', 'AI_EMPTY_OUTPUT');
  });

  it('refuse une réponse non JSON — jamais de tentative de réparation', () => {
    expectInvalid('Bien sûr ! Voici ma réponse au client.', 'AI_INVALID_JSON');
  });

  it('refuse une action inconnue', () => {
    expectInvalid(output({ action: 'SEND_NOW' }), 'AI_INVALID_OUTPUT_SHAPE');
  });

  it('refuse SUGGEST_REPLY sans texte — une action sans son contenu est invalide', () => {
    expectInvalid(output({ replyText: null }), 'AI_INVALID_OUTPUT_SHAPE');
    expectInvalid(output({ replyText: '   ' }), 'AI_INVALID_OUTPUT_SHAPE');
  });

  it('refuse HANDOFF sans raison', () => {
    expectInvalid(
      output({ action: 'HANDOFF', replyText: null, handoffReason: null }),
      'AI_INVALID_OUTPUT_SHAPE',
    );
  });

  it('accepte HANDOFF avec raison, et NO_REPLY sans texte', () => {
    expect(
      parseAiStructuredOutput(
        output({ action: 'HANDOFF', replyText: null, handoffReason: 'Demande de remboursement.' }),
      ).action,
    ).toBe('HANDOFF');
    expect(
      parseAiStructuredOutput(output({ action: 'NO_REPLY', replyText: null })).action,
    ).toBe('NO_REPLY');
  });

  it('refuse une confiance hors bornes', () => {
    expectInvalid(output({ confidence: 1.5 }), 'AI_INVALID_OUTPUT_SHAPE');
    expectInvalid(output({ confidence: -0.1 }), 'AI_INVALID_OUTPUT_SHAPE');
  });

  it('refuse un champ manquant (pas de valeur par défaut silencieuse)', () => {
    expectInvalid(
      JSON.stringify({ action: 'NO_REPLY', replyText: null, handoffReason: null }),
      'AI_INVALID_OUTPUT_SHAPE',
    );
  });

  it('ne fait jamais fuiter le texte brut du modèle dans le message d’erreur', () => {
    const secretish = output({ action: 'SEND_NOW', replyText: 'CONTENU-CONVERSATION-SENSIBLE' });
    try {
      parseAiStructuredOutput(secretish);
    } catch (error) {
      expect((error as Error).message).not.toContain('CONTENU-CONVERSATION-SENSIBLE');
    }
  });
});
