
import { AiProviderError, type AiErrorClass } from './errors';
import type { AiProvider } from './provider.interface';
import {
  AI_STRUCTURED_OUTPUT_JSON_SCHEMA,
  parseAiStructuredOutput,
} from './structured-output';
import type {
  AiConfigurationCheck,
  AiContinueInput,
  AiFinishReason,
  AiGenerateInput,
  AiProviderName,
  AiProviderResponse,
  AiToolCall,
  AiToolDefinition,
  AiToolResult,
  AiUsage,
} from './types';

/**
 * Configuration INJECTÉE (D10 validée) : le package ne lit jamais process.env.
 * La clé API est transmise UNIQUEMENT via l'en-tête `x-goog-api-key`
 * (ajustement 2) — jamais dans l'URL, un log ou un message d'erreur.
 */
export interface GeminiProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  apiVersion: string;
  timeoutMs: number;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  /**
   * Signature opaque attachée par Gemini à une part de functionCall (modèles
   * récents). Capturée telle quelle et RÉÉMISE à l'identique en continuation —
   * jamais décodée, normalisée ni loggée.
   */
  thoughtSignature?: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponseBody {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
}

/** Mapping AiToolDefinition → functionDeclarations Gemini (ajustement 4). */
function toFunctionDeclarations(tools: AiToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/** finishReason Gemini → interne. Défensif : inconnu/absent → OTHER. */
function mapFinishReason(reason: string | undefined): AiFinishReason {
  switch (reason) {
    case 'STOP':
      return 'STOP';
    case 'MAX_TOKENS':
      return 'MAX_TOKENS';
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'SAFETY';
    default:
      return 'OTHER';
  }
}

function mapUsage(body: GeminiResponseBody): AiUsage {
  const usage = body.usageMetadata;
  return {
    inputTokens: usage?.promptTokenCount ?? null,
    outputTokens: usage?.candidatesTokenCount ?? null,
    totalTokens: usage?.totalTokenCount ?? null,
  };
}

/**
 * Provider Gemini via l'API REST generateContent. Aucune dépendance au SDK
 * Google : tout passe par `fetch`, ce qui permet de pointer `baseUrl` vers un
 * faux serveur local et d'exercer le VRAI provider dans les tests.
 *
 * Garantie (ajustement 7) : AUCUNE erreur fetch, AbortError ou Google brute ne
 * sort du provider — tout est traduit en `AiProviderError` classée.
 */
export class GeminiAiProvider implements AiProvider {
  constructor(private readonly config: GeminiProviderConfig) {}

  getProviderName(): AiProviderName {
    return 'GEMINI';
  }

  /** URL construite de façon centralisée (ajustement 1) — modèle encodé, clé absente. */
  private generateContentUrl(): string {
    const { baseUrl, apiVersion, model } = this.config;
    return `${baseUrl}/${apiVersion}/models/${encodeURIComponent(model)}:generateContent`;
  }

  private modelUrl(): string {
    const { baseUrl, apiVersion, model } = this.config;
    return `${baseUrl}/${apiVersion}/models/${encodeURIComponent(model)}`;
  }

  async generateSuggestion(input: AiGenerateInput): Promise<AiProviderResponse> {
    return this.call(this.buildRequestBody(input));
  }

  async continueWithToolResults(input: AiContinueInput): Promise<AiProviderResponse> {
    return this.call(this.buildRequestBody(input, input.previousToolCalls, input.toolResults));
  }

  /**
   * Vérification de configuration — LECTURE seule (GET du modèle), jamais une
   * génération facturée. Ne lève jamais : renvoie ok=false et ne divulgue
   * aucun secret.
   */
  async validateConfiguration(): Promise<AiConfigurationCheck> {
    try {
      const response = await this.fetchWithTimeout(this.modelUrl(), { method: 'GET' });
      return { ok: response.ok, model: response.ok ? this.config.model : undefined };
    } catch {
      return { ok: false };
    }
  }

  /**
   * Construit le corps generateContent. Le prompt système passe par
   * `systemInstruction` — JAMAIS simulé comme un message utilisateur
   * (ajustement 6). Les rôles internes CUSTOMER/AGENT deviennent user/model.
   */
  private buildRequestBody(
    input: AiGenerateInput,
    previousToolCalls: AiToolCall[] = [],
    toolResults: AiToolResult[] = [],
  ): Record<string, unknown> {
    const contents: GeminiContent[] = [];

    for (const message of input.messages) {
      if (message.role === 'SYSTEM') {
        continue; // Le système vit dans systemInstruction, jamais dans contents.
      }
      contents.push({
        role: message.role === 'CUSTOMER' ? 'user' : 'model',
        parts: [{ text: message.content }],
      });
    }

    // Tour de continuation : rejoue les appels du modèle puis leurs résultats.
    // La thoughtSignature de CHAQUE appel est réémise EXACTEMENT sur SA part
    // (jamais déplacée, jamais mutualisée) — l'ordre des parts est préservé.
    if (previousToolCalls.length > 0) {
      contents.push({
        role: 'model',
        parts: previousToolCalls.map((call) => ({
          functionCall: { name: call.name, args: call.arguments },
          ...(call.providerMetadata?.thoughtSignature !== undefined
            ? { thoughtSignature: call.providerMetadata.thoughtSignature }
            : {}),
        })),
      });
      contents.push({
        role: 'user',
        parts: toolResults.map((result) => ({
          functionResponse: {
            name: result.name,
            response: { result: result.result, isError: result.isError ?? false },
          },
        })),
      });
    }

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: input.systemPrompt }] },
      contents,
      generationConfig: {
        maxOutputTokens: input.maxOutputTokens,
      },
    };

    const isContinuation = previousToolCalls.length > 0;

    if (input.tools.length > 0) {
      body.tools = [{ functionDeclarations: toFunctionDeclarations(input.tools) }];
    }

    // Structured output imposé quand on attend une RÉPONSE FINALE :
    // - 1ᵉʳ tour SANS outil (le modèle répond directement) ;
    // - tour de CONTINUATION (après les résultats d'outils) — vérifié en réel :
    //   Gemini accepte `tools` + `responseSchema` ensemble et renvoie du JSON
    //   structuré valide. On ne l'impose PAS au 1ᵉʳ tour AVEC outils, pour
    //   laisser le modèle émettre un functionCall.
    if (input.tools.length === 0 || isContinuation) {
      (body.generationConfig as Record<string, unknown>).responseMimeType = 'application/json';
      (body.generationConfig as Record<string, unknown>).responseSchema =
        AI_STRUCTURED_OUTPUT_JSON_SCHEMA;
    }

    return body;
  }

  private async call(body: Record<string, unknown>): Promise<AiProviderResponse> {
    const startedAt = Date.now();
    const response = await this.fetchWithTimeout(this.generateContentUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      await this.throwHttpError(response);
    }

    let parsed: GeminiResponseBody;
    try {
      parsed = (await response.json()) as GeminiResponseBody;
    } catch {
      throw new AiProviderError('Réponse HTTP Gemini non JSON.', 'GEMINI_HTTP_INVALID_JSON', 'INVALID_OUTPUT');
    }

    // La validation structurée est STRICTE dès que responseSchema a été imposé
    // (1ᵉʳ tour sans outil OU continuation) — pas selon la présence d'outils.
    // Sur un 1ᵉʳ tour AVEC outils (functionCall attendu, pas de responseSchema),
    // le texte éventuel reste best-effort et n'est pas validé ici.
    const enforceStructured =
      (body.generationConfig as Record<string, unknown> | undefined)?.responseSchema !== undefined;
    return this.parseResponse(parsed, latencyMs, enforceStructured);
  }

  /** Parsing DÉFENSIF de la réponse (ajustement 5). */
  private parseResponse(
    body: GeminiResponseBody,
    latencyMs: number,
    enforceStructured: boolean,
  ): AiProviderResponse {
    const usage = mapUsage(body);
    const modelVersion = body.modelVersion ?? null;

    // Réponse bloquée en amont (sécurité) : issue légitime → SAFETY, jamais une
    // erreur ni une réponse inventée. Le worker décidera d'un handoff.
    if (body.promptFeedback?.blockReason) {
      return { text: null, toolCalls: [], finishReason: 'SAFETY', usage, latencyMs, modelVersion };
    }

    const candidate = body.candidates?.[0];
    if (!candidate) {
      throw new AiProviderError(
        'Réponse Gemini sans candidat exploitable.',
        'GEMINI_NO_CANDIDATE',
        'INVALID_OUTPUT',
      );
    }

    const parts = candidate.content?.parts ?? [];
    const finishReason = mapFinishReason(candidate.finishReason);

    const toolCalls: AiToolCall[] = [];
    let text = '';
    parts.forEach((part, index) => {
      if (part.functionCall?.name) {
        // Signature capturée BYTE-FOR-BYTE, associée à CET appel précis. Absente
        // sur les modèles qui ne l'exigent pas → rétrocompatible.
        const thoughtSignature = part.thoughtSignature;
        toolCalls.push({
          id: `${part.functionCall.name}-${index}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
          ...(thoughtSignature !== undefined
            ? { providerMetadata: { thoughtSignature } }
            : {}),
        });
      } else if (typeof part.text === 'string') {
        text += part.text;
      }
    });

    // Le modèle appelle un outil : pas de sortie structurée à valider.
    if (toolCalls.length > 0) {
      return { text: null, toolCalls, finishReason: 'TOOL_CALLS', usage, latencyMs, modelVersion };
    }

    // Bloqué au niveau candidat, ou aucun contenu exploitable → pas de texte
    // à valider ; issue légitime remontée telle quelle (le worker gère).
    if (finishReason === 'SAFETY' || text.trim() === '') {
      return { text: null, toolCalls: [], finishReason, usage, latencyMs, modelVersion };
    }

    // Texte final. Sans outil (responseSchema imposé), on VALIDE ici la sortie
    // structurée (ajustement 3, seconde moitié) et on lève INVALID_OUTPUT si non
    // conforme — jamais de réparation sémantique. Avec outils, on renvoie le
    // texte brut : l'orchestrateur validera (et pourra retenter une fois).
    if (enforceStructured) {
      parseAiStructuredOutput(text);
    }
    return { text, toolCalls: [], finishReason, usage, latencyMs, modelVersion };
  }

  /** fetch borné par AbortController — aucune erreur brute ne s'échappe. */
  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          // Clé UNIQUEMENT en en-tête (ajustement 2), jamais dans l'URL.
          'x-goog-api-key': this.config.apiKey,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AiProviderError('Délai Gemini dépassé.', 'GEMINI_TIMEOUT', 'RETRYABLE');
      }
      // Erreur réseau brute filtrée : jamais exposée telle quelle.
      throw new AiProviderError('Erreur réseau Gemini.', 'GEMINI_NETWORK', 'RETRYABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Classification HTTP (ajustement 8). N'échoue jamais à cause du corps
   * d'erreur : on n'extrait qu'un statut Google borné (jamais la clé, jamais
   * un message libre potentiellement sensible).
   */
  private async throwHttpError(response: Response): Promise<never> {
    let googleStatus = '';
    try {
      const errorBody = (await response.json()) as { error?: { status?: string } };
      googleStatus = typeof errorBody.error?.status === 'string' ? ` (${errorBody.error.status})` : '';
    } catch {
      // Corps illisible : on se contente du code HTTP.
    }

    const status = response.status;
    let errorClass: AiErrorClass;
    if (status === 400) {
      errorClass = 'NON_RETRYABLE';
    } else if (status === 401 || status === 403 || status === 404) {
      errorClass = 'CONFIGURATION_ERROR';
    } else if (status === 408) {
      errorClass = 'RETRYABLE';
    } else if (status === 429) {
      errorClass = 'QUOTA_ERROR';
    } else if (status >= 500) {
      errorClass = 'RETRYABLE';
    } else {
      errorClass = 'NON_RETRYABLE';
    }

    throw new AiProviderError(
      `Erreur HTTP Gemini ${status}${googleStatus}.`,
      `GEMINI_HTTP_${status}`,
      errorClass,
    );
  }
}
