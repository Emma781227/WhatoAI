import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AiProviderError } from './errors';
import { GeminiAiProvider, type GeminiProviderConfig } from './gemini-provider';
import { parseAiStructuredOutput } from './structured-output';
import type { AiContinueInput, AiGenerateInput, AiToolCall } from './types';

/**
 * FAUX serveur Gemini local exerçant le VRAI GeminiAiProvider (ajustement 12) :
 * on vérifie l'URL, la version, le modèle, la clé UNIQUEMENT en en-tête, le
 * payload, le structured schema, le parsing (texte / functionCall / usage /
 * candidats vides / sortie invalide) et la classification des erreurs HTTP —
 * sans jamais appeler Google.
 */

interface CapturedRequest {
  method: string;
  url: string;
  headers: NodeJS.Dict<string | string[]>;
  body: unknown;
}

type Scenario =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'raw'; status: number; text: string }
  | { kind: 'hang' };

let server: Server;
let baseUrl: string;
let lastRequest: CapturedRequest | null = null;
let scenario: Scenario = { kind: 'json', status: 200, body: {} };
/** File de réponses (multi-tours) : prioritaire sur `scenario` quand non vide. */
let responseQueue: unknown[] = [];
/**
 * Validation de continuation (reproduit Gemini réel) : si défini, toute requête
 * de continuation (contenant un functionResponse) doit rejouer la thoughtSignature
 * ATTENDUE sur la part model.functionCall — sinon 400 INVALID_ARGUMENT.
 */
let expectedContinuationSig: string | null = null;

interface PartShape {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}
interface ContentShape {
  role: string;
  parts: PartShape[];
}

function isContinuationRequest(body: unknown): boolean {
  const contents = (body as { contents?: ContentShape[] } | null)?.contents ?? [];
  return contents.some((c) => c.parts.some((p) => p.functionResponse !== undefined));
}
function modelFunctionCallSignature(body: unknown): string | undefined {
  const contents = (body as { contents?: ContentShape[] } | null)?.contents ?? [];
  const modelPart = contents
    .filter((c) => c.role === 'model')
    .flatMap((c) => c.parts)
    .find((p) => p.functionCall !== undefined);
  return modelPart?.thoughtSignature;
}

const STRUCTURED_TEXT = JSON.stringify({
  action: 'SUGGEST_REPLY',
  replyText: 'Bonjour, oui ce produit est disponible.',
  handoffReason: null,
  confidence: 0.9,
  usedBusinessData: true,
});

interface RequestBody {
  systemInstruction: { parts: Array<{ text: string }> };
  contents: ContentShape[];
  generationConfig: Record<string, unknown>;
  tools?: Array<{ functionDeclarations: Array<{ name: string }> }>;
}

function reqBody(): RequestBody {
  return lastRequest?.body as RequestBody;
}

function structuredCandidate(): unknown {
  return {
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: STRUCTURED_TEXT }] } }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 },
  };
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      lastRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      };
      if (scenario.kind === 'hang') {
        return; // Ne répond jamais : force l'AbortController du provider.
      }
      // Validation de la thoughtSignature en continuation (comme Gemini réel).
      if (expectedContinuationSig !== null && isContinuationRequest(lastRequest.body)) {
        if (modelFunctionCallSignature(lastRequest.body) !== expectedContinuationSig) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 400,
                status: 'INVALID_ARGUMENT',
                message: 'Function call is missing a thought_signature in functionCall parts.',
              },
            }),
          );
          return;
        }
      }
      // File multi-tours prioritaire.
      if (responseQueue.length > 0) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(responseQueue.shift()));
        return;
      }
      if (scenario.kind === 'raw') {
        res.writeHead(scenario.status, { 'content-type': 'application/json' });
        res.end(scenario.text);
        return;
      }
      res.writeHead(scenario.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scenario.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  lastRequest = null;
  scenario = { kind: 'json', status: 200, body: structuredCandidate() };
  responseQueue = [];
  expectedContinuationSig = null;
});

function makeProvider(overrides: Partial<GeminiProviderConfig> = {}): GeminiAiProvider {
  return new GeminiAiProvider({
    apiKey: 'SECRET-KEY-123',
    model: 'gemini-2.5-flash-lite',
    baseUrl,
    apiVersion: 'v1beta',
    timeoutMs: 2000,
    ...overrides,
  });
}

function input(overrides: Partial<AiGenerateInput> = {}): AiGenerateInput {
  return {
    systemPrompt: 'Tu es l’assistant commercial.',
    messages: [
      { role: 'CUSTOMER', content: 'un ancien message' },
      { role: 'AGENT', content: 'une réponse agent' },
      { role: 'CUSTOMER', content: 'Vous avez des sacs rouges ?' },
    ],
    tools: [],
    maxOutputTokens: 300,
    ...overrides,
  };
}

async function expectError(promise: Promise<unknown>, code: string, errorClass: string): Promise<void> {
  try {
    await promise;
    throw new Error('aurait dû lever');
  } catch (error) {
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe(code);
    expect((error as AiProviderError).errorClass).toBe(errorClass);
  }
}

describe('GeminiAiProvider — contrat HTTP', () => {
  it('construit l’URL {base}/{version}/models/{model}:generateContent', async () => {
    await makeProvider().generateSuggestion(input());
    expect(lastRequest?.method).toBe('POST');
    expect(lastRequest?.url).toBe('/v1beta/models/gemini-2.5-flash-lite:generateContent');
  });

  it('transmet la clé UNIQUEMENT en en-tête x-goog-api-key, jamais dans l’URL', async () => {
    await makeProvider().generateSuggestion(input());
    expect(lastRequest?.headers['x-goog-api-key']).toBe('SECRET-KEY-123');
    expect(lastRequest?.url).not.toContain('SECRET-KEY-123');
    expect(lastRequest?.url).not.toMatch(/key=/i);
  });

  it('envoie le prompt système via systemInstruction, pas comme message user', async () => {
    await makeProvider().generateSuggestion(input());
    const body = reqBody();
    expect(body.systemInstruction.parts[0].text).toContain('assistant commercial');
    // Aucun message user ne contient le prompt système.
    const userTexts = body.contents.map((content) => content.parts[0].text);
    expect(userTexts).not.toContain('Tu es l’assistant commercial.');
  });

  it('mappe les rôles CUSTOMER→user et AGENT→model', async () => {
    await makeProvider().generateSuggestion(input());
    expect(reqBody().contents.map((content) => content.role)).toEqual(['user', 'model', 'user']);
  });

  it('sans outil : impose responseSchema (structured output côté requête)', async () => {
    await makeProvider().generateSuggestion(input());
    const body = reqBody();
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toBeDefined();
    expect(body.tools).toBeUndefined();
  });

  it('avec outils : mappe functionDeclarations et n’impose pas responseSchema', async () => {
    scenario = {
      kind: 'json',
      status: 200,
      body: {
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ functionCall: { name: 'search_products', args: { query: 'sac' } } }] },
          },
        ],
      },
    };
    const result = await makeProvider().generateSuggestion(
      input({
        tools: [
          {
            name: 'search_products',
            description: 'Recherche produits',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      }),
    );
    const body = reqBody();
    expect(body.tools?.[0].functionDeclarations[0].name).toBe('search_products');
    expect(body.generationConfig.responseSchema).toBeUndefined();
    // functionCall → AiToolCall interne.
    expect(result.finishReason).toBe('TOOL_CALLS');
    expect(result.toolCalls[0].name).toBe('search_products');
    expect(result.toolCalls[0].arguments).toEqual({ query: 'sac' });
    expect(result.text).toBeNull();
  });
});

describe('GeminiAiProvider — thoughtSignature (function calling)', () => {
  // Signature réaliste (base64url avec caractères spéciaux) — testée byte-for-byte.
  const SIG_A = 'Cq0BAbc+/def==GHi_jkl';
  const SIG_B = 'Zz9WmN0pQ+rS/tUv==';
  const TOOLS = [
    {
      name: 'search_products',
      description: 'Recherche produits',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ];

  function fnCallResponse(calls: Array<{ name: string; sig?: string }>): unknown {
    return {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: calls.map((c) => ({
              functionCall: { name: c.name, args: { query: 'sac' } },
              ...(c.sig !== undefined ? { thoughtSignature: c.sig } : {}),
            })),
          },
        },
      ],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10, totalTokenCount: 40 },
    };
  }

  function continueInput(previousToolCalls: AiToolCall[]): AiContinueInput {
    return {
      ...input({ tools: TOOLS }),
      previousToolCalls,
      toolResults: previousToolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        result: { products: [{ name: 'Sac Cabas Test', priceFromMinor: 15000 }] },
      })),
    };
  }

  it('capture la thoughtSignature BYTE-FOR-BYTE et l’associe au bon appel', async () => {
    scenario = { kind: 'json', status: 200, body: fnCallResponse([{ name: 'search_products', sig: SIG_A }]) };
    const result = await makeProvider().generateSuggestion(input({ tools: TOOLS }));
    expect(result.finishReason).toBe('TOOL_CALLS');
    expect(result.toolCalls[0].providerMetadata?.thoughtSignature).toBe(SIG_A);
    // Aucune mutation des args.
    expect(result.toolCalls[0].arguments).toEqual({ query: 'sac' });
  });

  it('continuation : impose responseSchema (structured output après outil) — vérifié en réel', async () => {
    const toolCall: AiToolCall = {
      id: 'search_products-0',
      name: 'search_products',
      arguments: { query: 'sac' },
      providerMetadata: { thoughtSignature: SIG_A },
    };
    await makeProvider().continueWithToolResults(continueInput([toolCall]));
    const gc = reqBody().generationConfig;
    expect(gc.responseMimeType).toBe('application/json');
    expect(gc.responseSchema).toBeDefined();
    // Les outils restent déclarés en continuation (tools + responseSchema ensemble).
    expect(reqBody().tools).toBeDefined();
  });

  it('réémet la signature EXACTE sur la part model.functionCall en continuation', async () => {
    scenario = { kind: 'json', status: 200, body: structuredCandidate() };
    const toolCall: AiToolCall = {
      id: 'search_products-0',
      name: 'search_products',
      arguments: { query: 'sac' },
      providerMetadata: { thoughtSignature: SIG_A },
    };
    await makeProvider().continueWithToolResults(continueInput([toolCall]));
    const modelPart = reqBody()
      .contents.filter((c) => c.role === 'model')
      .flatMap((c) => c.parts)
      .find((p) => p.functionCall);
    expect(modelPart?.thoughtSignature).toBe(SIG_A);
    expect(modelPart?.functionCall?.name).toBe('search_products');
  });

  it('continuation avec signature correcte → succès (serveur valide)', async () => {
    expectedContinuationSig = SIG_A;
    responseQueue = [structuredCandidate()];
    const toolCall: AiToolCall = {
      id: 'search_products-0',
      name: 'search_products',
      arguments: { query: 'sac' },
      providerMetadata: { thoughtSignature: SIG_A },
    };
    const result = await makeProvider().continueWithToolResults(continueInput([toolCall]));
    expect(parseAiStructuredOutput(result.text).action).toBe('SUGGEST_REPLY');
  });

  it('signature ABSENTE en continuation → 400 (comme Gemini réel)', async () => {
    expectedContinuationSig = SIG_A;
    const toolCall: AiToolCall = { id: 'x', name: 'search_products', arguments: { query: 'sac' } };
    await expectError(
      makeProvider().continueWithToolResults(continueInput([toolCall])),
      'GEMINI_HTTP_400',
      'NON_RETRYABLE',
    );
  });

  it('signature MODIFIÉE en continuation → 400', async () => {
    expectedContinuationSig = SIG_A;
    const toolCall: AiToolCall = {
      id: 'x',
      name: 'search_products',
      arguments: { query: 'sac' },
      providerMetadata: { thoughtSignature: `${SIG_A}-altered` },
    };
    await expectError(
      makeProvider().continueWithToolResults(continueInput([toolCall])),
      'GEMINI_HTTP_400',
      'NON_RETRYABLE',
    );
  });

  it('deux functionCalls → deux signatures distinctes, chacune sur SA part (ordre préservé)', async () => {
    scenario = {
      kind: 'json',
      status: 200,
      body: fnCallResponse([
        { name: 'search_products', sig: SIG_A },
        { name: 'get_shop_opening_hours', sig: SIG_B },
      ]),
    };
    const result = await makeProvider().generateSuggestion(input({ tools: TOOLS }));
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].providerMetadata?.thoughtSignature).toBe(SIG_A);
    expect(result.toolCalls[1].providerMetadata?.thoughtSignature).toBe(SIG_B);

    // Continuation : chaque signature reste sur SA part, dans l'ordre.
    await makeProvider().continueWithToolResults(continueInput(result.toolCalls));
    const modelParts = reqBody()
      .contents.filter((c) => c.role === 'model')
      .flatMap((c) => c.parts)
      .filter((p) => p.functionCall);
    expect(modelParts[0].thoughtSignature).toBe(SIG_A);
    expect(modelParts[1].thoughtSignature).toBe(SIG_B);
    expect(modelParts[0].functionCall?.name).toBe('search_products');
    expect(modelParts[1].functionCall?.name).toBe('get_shop_opening_hours');
  });

  it('modèle SANS signature → rétrocompatible (aucune providerMetadata, continuation sans thoughtSignature)', async () => {
    scenario = { kind: 'json', status: 200, body: fnCallResponse([{ name: 'search_products' }]) };
    const result = await makeProvider().generateSuggestion(input({ tools: TOOLS }));
    expect(result.toolCalls[0].providerMetadata).toBeUndefined();

    scenario = { kind: 'json', status: 200, body: structuredCandidate() };
    await makeProvider().continueWithToolResults(continueInput(result.toolCalls));
    const modelPart = reqBody()
      .contents.filter((c) => c.role === 'model')
      .flatMap((c) => c.parts)
      .find((p) => p.functionCall);
    expect(modelPart?.thoughtSignature).toBeUndefined();
  });

  it('un 400 de continuation ne fait JAMAIS fuiter la signature dans l’erreur', async () => {
    expectedContinuationSig = SIG_A;
    const toolCall: AiToolCall = {
      id: 'x',
      name: 'search_products',
      arguments: { query: 'sac' },
      providerMetadata: { thoughtSignature: `${SIG_A}-wrong` },
    };
    try {
      await makeProvider().continueWithToolResults(continueInput([toolCall]));
      throw new Error('aurait dû lever');
    } catch (error) {
      expect((error as AiProviderError).message).not.toContain(SIG_A);
      expect((error as AiProviderError).message).not.toContain('altered');
    }
  });
});

describe('GeminiAiProvider — parsing des réponses', () => {
  it('texte structuré valide + usage mappé', async () => {
    const result = await makeProvider().generateSuggestion(input());
    expect(result.finishReason).toBe('STOP');
    expect(parseAiStructuredOutput(result.text).action).toBe('SUGGEST_REPLY');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
  });

  it('usage absent → null, jamais de calcul local', async () => {
    scenario = {
      kind: 'json',
      status: 200,
      body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: STRUCTURED_TEXT }] } }] },
    };
    const result = await makeProvider().generateSuggestion(input());
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });

  it('concatène plusieurs parts de texte', async () => {
    const full = STRUCTURED_TEXT;
    const half = Math.floor(full.length / 2);
    scenario = {
      kind: 'json',
      status: 200,
      body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: full.slice(0, half) }, { text: full.slice(half) }] } }] },
    };
    const result = await makeProvider().generateSuggestion(input());
    expect(parseAiStructuredOutput(result.text).action).toBe('SUGGEST_REPLY');
  });

  it('réponse bloquée (promptFeedback.blockReason) → SAFETY, jamais une erreur', async () => {
    scenario = { kind: 'json', status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } };
    const result = await makeProvider().generateSuggestion(input());
    expect(result.finishReason).toBe('SAFETY');
    expect(result.text).toBeNull();
  });

  it('candidat finishReason SAFETY sans texte → SAFETY', async () => {
    scenario = { kind: 'json', status: 200, body: { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] } };
    const result = await makeProvider().generateSuggestion(input());
    expect(result.finishReason).toBe('SAFETY');
    expect(result.text).toBeNull();
  });

  it('candidats vide → INVALID_OUTPUT', async () => {
    scenario = { kind: 'json', status: 200, body: { candidates: [] } };
    await expectError(makeProvider().generateSuggestion(input()), 'GEMINI_NO_CANDIDATE', 'INVALID_OUTPUT');
  });

  it('candidats absent → INVALID_OUTPUT', async () => {
    scenario = { kind: 'json', status: 200, body: {} };
    await expectError(makeProvider().generateSuggestion(input()), 'GEMINI_NO_CANDIDATE', 'INVALID_OUTPUT');
  });

  it('structured output invalide (texte non conforme) → INVALID_OUTPUT, jamais réparé', async () => {
    scenario = {
      kind: 'json',
      status: 200,
      body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Bien sûr, voici la réponse !' }] } }] },
    };
    await expectError(makeProvider().generateSuggestion(input()), 'AI_INVALID_JSON', 'INVALID_OUTPUT');
  });

  it('corps HTTP 200 non JSON → INVALID_OUTPUT', async () => {
    scenario = { kind: 'raw', status: 200, text: '<html>oops</html>' };
    await expectError(makeProvider().generateSuggestion(input()), 'GEMINI_HTTP_INVALID_JSON', 'INVALID_OUTPUT');
  });
});

describe('GeminiAiProvider — classification des erreurs (ajustement 8)', () => {
  it.each([
    [400, 'GEMINI_HTTP_400', 'NON_RETRYABLE'],
    [401, 'GEMINI_HTTP_401', 'CONFIGURATION_ERROR'],
    [403, 'GEMINI_HTTP_403', 'CONFIGURATION_ERROR'],
    [404, 'GEMINI_HTTP_404', 'CONFIGURATION_ERROR'],
    [408, 'GEMINI_HTTP_408', 'RETRYABLE'],
    [429, 'GEMINI_HTTP_429', 'QUOTA_ERROR'],
    [500, 'GEMINI_HTTP_500', 'RETRYABLE'],
    [503, 'GEMINI_HTTP_503', 'RETRYABLE'],
  ])('HTTP %i → %s / %s', async (status, code, errorClass) => {
    scenario = { kind: 'json', status, body: { error: { status: 'X' } } };
    await expectError(makeProvider().generateSuggestion(input()), code as string, errorClass as string);
  });

  it('timeout (serveur muet) → GEMINI_TIMEOUT / RETRYABLE, jamais une AbortError brute', async () => {
    scenario = { kind: 'hang' };
    await expectError(
      makeProvider({ timeoutMs: 150 }).generateSuggestion(input()),
      'GEMINI_TIMEOUT',
      'RETRYABLE',
    );
  });

  it('ne fait jamais fuiter la clé API dans un message d’erreur', async () => {
    scenario = { kind: 'json', status: 500, body: { error: { status: 'INTERNAL', message: 'boom' } } };
    try {
      await makeProvider().generateSuggestion(input());
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET-KEY-123');
    }
  });
});

describe('GeminiAiProvider — validateConfiguration (lecture seule)', () => {
  it('GET du modèle, aucune génération — ok=true sur 200', async () => {
    scenario = { kind: 'json', status: 200, body: { name: 'models/gemini-2.5-flash-lite' } };
    const result = await makeProvider().validateConfiguration();
    expect(lastRequest?.method).toBe('GET');
    expect(lastRequest?.url).toBe('/v1beta/models/gemini-2.5-flash-lite');
    expect(result).toEqual({ ok: true, model: 'gemini-2.5-flash-lite' });
  });

  it('clé invalide (401) → ok=false, jamais d’exception ni de secret', async () => {
    scenario = { kind: 'json', status: 401, body: { error: { status: 'UNAUTHENTICATED' } } };
    await expect(makeProvider().validateConfiguration()).resolves.toEqual({ ok: false });
  });
});
