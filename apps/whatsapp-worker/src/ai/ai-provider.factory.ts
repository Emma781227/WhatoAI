import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeminiAiProvider, MockAiProvider, type AiProvider } from '@whauto/ai';
import type { AiProviderType } from '@whauto/database';

/**
 * Fabrique de provider IA. Choisit MOCK ou GEMINI par run, la config Gemini
 * venant EXCLUSIVEMENT de l'environnement (la clé ne quitte jamais le worker).
 * Un GEMINI demandé sans clé retombe proprement sur une erreur de config à
 * l'appel du provider, jamais sur une clé vide silencieuse ici.
 */
@Injectable()
export class AiProviderFactory {
  constructor(private readonly configService: ConfigService) {}

  getProvider(providerType: AiProviderType, model: string): AiProvider {
    if (providerType === 'GEMINI') {
      return new GeminiAiProvider({
        apiKey: this.configService.get<string>('GEMINI_API_KEY') ?? '',
        model,
        baseUrl:
          this.configService.get<string>('GEMINI_API_BASE_URL') ??
          'https://generativelanguage.googleapis.com',
        apiVersion: this.configService.get<string>('GEMINI_API_VERSION') ?? 'v1beta',
        timeoutMs: this.configService.get<number>('AI_REQUEST_TIMEOUT_MS') ?? 30000,
      });
    }
    return new MockAiProvider();
  }
}
