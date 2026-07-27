import { AiProviderError } from './errors';
import { AI_ACTIONS } from './structured-output';
import type { AiProvider } from './provider.interface';
import type {
  AiConfigurationCheck,
  AiContinueInput,
  AiGenerateInput,
  AiInputMessage,
  AiProviderName,
  AiProviderResponse,
} from './types';

/**
 * Provider IA MOCK — implémentation explicitement factice (aucun appel réseau,
 * aucun modèle). Elle existe pour deux usages légitimes :
 * - faire tourner la pipeline IA complète en développement et en e2e sans
 *   consommer de quota ni dépendre du réseau ;
 * - rendre les scénarios déterministes (un même message donne toujours la
 *   même sortie).
 *
 * Elle n'est JAMAIS présentée comme un service réel : le choix du provider est
 * explicite (`AI_PROVIDER`), et ce mock ne prétend rien comprendre — il
 * applique des règles littérales sur le dernier message client.
 */

/** Déclencheurs de test, reconnus littéralement dans le dernier message client. */
export const MOCK_AI_TRIGGERS = {
  RETRYABLE_FAILURE: '!ai-fail',
  QUOTA: '!ai-quota',
  INVALID_OUTPUT: '!ai-invalid',
  HANDOFF: '!ai-handoff',
  /** Force un appel d'outil au premier tour (test de la boucle). */
  TOOL: '!ai-tool',
} as const;

const HANDOFF_KEYWORDS = ['remboursement', 'annuler', 'annulation', 'réclamation', 'litige'];

function lastCustomerMessage(messages: AiInputMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'CUSTOMER') {
      return messages[index].content;
    }
  }
  return '';
}

function response(partial: Partial<AiProviderResponse> & { text: string | null }): AiProviderResponse {
  return {
    toolCalls: [],
    finishReason: 'STOP',
    usage: { inputTokens: 42, outputTokens: 21, totalTokens: 63 },
    latencyMs: 1,
    modelVersion: 'mock-model',
    ...partial,
  };
}

function structured(action: (typeof AI_ACTIONS)[number], fields: Record<string, unknown>): string {
  return JSON.stringify({
    action,
    replyText: null,
    handoffReason: null,
    confidence: 0.9,
    usedBusinessData: false,
    ...fields,
  });
}

export class MockAiProvider implements AiProvider {
  getProviderName(): AiProviderName {
    return 'MOCK';
  }

  async generateSuggestion(input: AiGenerateInput): Promise<AiProviderResponse> {
    const text = lastCustomerMessage(input.messages);

    if (text.includes(MOCK_AI_TRIGGERS.RETRYABLE_FAILURE)) {
      throw new AiProviderError('Panne simulée du provider IA.', 'MOCK_AI_FAILURE', 'RETRYABLE');
    }
    if (text.includes(MOCK_AI_TRIGGERS.QUOTA)) {
      throw new AiProviderError('Quota simulé dépassé.', 'MOCK_AI_QUOTA', 'QUOTA_ERROR');
    }
    if (text.includes(MOCK_AI_TRIGGERS.INVALID_OUTPUT)) {
      // Sortie volontairement non structurée : exerce la validation Zod.
      return response({ text: 'je ne suis pas du JSON' });
    }
    if (text.includes(MOCK_AI_TRIGGERS.TOOL) && input.tools.length > 0) {
      return response({
        text: null,
        finishReason: 'TOOL_CALLS',
        toolCalls: [
          {
            id: 'mock-tool-1',
            name: input.tools[0].name,
            arguments: { query: text.replace(MOCK_AI_TRIGGERS.TOOL, '').trim(), limit: 3 },
          },
        ],
      });
    }
    if (
      text.includes(MOCK_AI_TRIGGERS.HANDOFF) ||
      HANDOFF_KEYWORDS.some((keyword) => text.toLowerCase().includes(keyword))
    ) {
      return response({
        text: structured('HANDOFF', { handoffReason: 'Demande sensible détectée (mock).' }),
      });
    }

    return response({
      text: structured('SUGGEST_REPLY', {
        replyText: `Bonjour ! Merci pour votre message : « ${text.slice(0, 120)} ». Comment puis-je vous aider ?`,
      }),
    });
  }

  async continueWithToolResults(input: AiContinueInput): Promise<AiProviderResponse> {
    const failed = input.toolResults.some((result) => result.isError === true);
    if (failed) {
      // Un outil en erreur ne doit jamais produire une réponse inventée.
      return response({
        text: structured('HANDOFF', { handoffReason: 'Outil métier en erreur (mock).' }),
      });
    }

    return response({
      text: structured('SUGGEST_REPLY', {
        replyText: `D'après nos informations : ${JSON.stringify(input.toolResults[0]?.result ?? null).slice(0, 200)}`,
        usedBusinessData: true,
      }),
    });
  }

  async validateConfiguration(): Promise<AiConfigurationCheck> {
    return { ok: true, model: 'mock-model' };
  }
}
