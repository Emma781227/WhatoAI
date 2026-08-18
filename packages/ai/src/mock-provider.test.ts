import { describe, expect, it } from 'vitest';

import { AiProviderError } from './errors';
import { MOCK_AI_TRIGGERS, MockAiProvider } from './mock-provider';
import { parseAiStructuredOutput } from './structured-output';
import type { AiGenerateInput, AiToolResult } from './types';

const TOOLS = [
  {
    name: 'search_products',
    description: 'Recherche de produits',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
];

function input(customerText: string, overrides: Partial<AiGenerateInput> = {}): AiGenerateInput {
  return {
    systemPrompt: 'Tu es l’assistant commercial de la boutique.',
    messages: [
      { role: 'CUSTOMER', content: 'un ancien message' },
      { role: 'AGENT', content: 'une ancienne réponse' },
      { role: 'CUSTOMER', content: customerText },
    ],
    tools: TOOLS,
    maxOutputTokens: 300,
    ...overrides,
  };
}

describe('MockAiProvider', () => {
  const provider = new MockAiProvider();

  it('s’annonce comme MOCK — jamais confondu avec un vrai fournisseur', () => {
    expect(provider.getProviderName()).toBe('MOCK');
  });

  it('produit une suggestion structurée valide sur un message ordinaire', async () => {
    const result = await provider.generateSuggestion(input('Bonjour, vous avez des sacs ?'));
    const parsed = parseAiStructuredOutput(result.text);
    expect(parsed.action).toBe('SUGGEST_REPLY');
    expect(parsed.replyText).toContain('sacs');
    expect(result.finishReason).toBe('STOP');
  });

  it('bascule en HANDOFF sur un sujet sensible', async () => {
    const result = await provider.generateSuggestion(input('je veux un remboursement'));
    const parsed = parseAiStructuredOutput(result.text);
    expect(parsed.action).toBe('HANDOFF');
    expect(parsed.handoffReason).not.toBeNull();
  });

  it('demande un outil quand le déclencheur est présent', async () => {
    const result = await provider.generateSuggestion(input(`${MOCK_AI_TRIGGERS.TOOL} robe rouge`));
    expect(result.finishReason).toBe('TOOL_CALLS');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('search_products');
    expect(result.text).toBeNull();
  });

  it('demande add_to_cart avec la variante donnée quand l’outil est exposé', async () => {
    const cartTools = [
      ...TOOLS,
      { name: 'add_to_cart', description: 'Ajoute au panier', parameters: { type: 'object' } },
    ];
    const result = await provider.generateSuggestion(
      input(`${MOCK_AI_TRIGGERS.CART} var_123`, { tools: cartTools }),
    );
    expect(result.finishReason).toBe('TOOL_CALLS');
    expect(result.toolCalls[0].name).toBe('add_to_cart');
    expect(result.toolCalls[0].arguments).toEqual({ variantId: 'var_123', quantity: 1 });
  });

  it('ne demande JAMAIS le panier si l’outil n’est pas exposé (verrou cartToolsEnabled)', async () => {
    const result = await provider.generateSuggestion(input(`${MOCK_AI_TRIGGERS.CART} var_123`));
    expect(result.toolCalls).toHaveLength(0);
    expect(result.finishReason).toBe('STOP');
  });

  it('ne demande jamais d’outil si aucun n’est déclaré', async () => {
    const result = await provider.generateSuggestion(
      input(`${MOCK_AI_TRIGGERS.TOOL} robe`, { tools: [] }),
    );
    expect(result.toolCalls).toHaveLength(0);
  });

  it.each([
    [MOCK_AI_TRIGGERS.RETRYABLE_FAILURE, 'RETRYABLE'],
    [MOCK_AI_TRIGGERS.QUOTA, 'QUOTA_ERROR'],
  ])('classe correctement l’échec simulé %s', async (trigger, expectedClass) => {
    await expect(provider.generateSuggestion(input(trigger))).rejects.toBeInstanceOf(
      AiProviderError,
    );
    await provider.generateSuggestion(input(trigger)).catch((error: AiProviderError) => {
      expect(error.errorClass).toBe(expectedClass);
    });
  });

  it('sortie invalide simulée : refusée par la validation, jamais interprétée', async () => {
    const result = await provider.generateSuggestion(input(MOCK_AI_TRIGGERS.INVALID_OUTPUT));
    expect(() => parseAiStructuredOutput(result.text)).toThrow(AiProviderError);
  });

  it('après résultats d’outils : suggestion marquée comme utilisant les données métier', async () => {
    const toolResults: AiToolResult[] = [
      { id: 'mock-tool-1', name: 'search_products', result: { products: ['Robe rouge'] } },
    ];
    const result = await provider.continueWithToolResults({
      ...input('robe rouge'),
      previousToolCalls: [{ id: 'mock-tool-1', name: 'search_products', arguments: {} }],
      toolResults,
    });
    const parsed = parseAiStructuredOutput(result.text);
    expect(parsed.action).toBe('SUGGEST_REPLY');
    expect(parsed.usedBusinessData).toBe(true);
  });

  it('outil en erreur : HANDOFF, jamais une réponse inventée', async () => {
    const result = await provider.continueWithToolResults({
      ...input('robe rouge'),
      previousToolCalls: [{ id: 'mock-tool-1', name: 'search_products', arguments: {} }],
      toolResults: [
        { id: 'mock-tool-1', name: 'search_products', result: null, isError: true },
      ],
    });
    expect(parseAiStructuredOutput(result.text).action).toBe('HANDOFF');
  });

  it('validateConfiguration ne déclenche aucune génération', async () => {
    await expect(provider.validateConfiguration()).resolves.toEqual({
      ok: true,
      model: 'mock-model',
    });
  });
});
