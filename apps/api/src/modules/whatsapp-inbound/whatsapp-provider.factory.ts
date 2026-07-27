import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WhatsAppProviderType } from '@whauto/database';
import { WhatsAppProviderNotImplementedError } from '@whauto/shared';
import { MetaCloudWhatsAppProvider, MockWhatsAppProvider } from '@whauto/whatsapp';
import type { WhatsAppProvider } from '@whauto/whatsapp';

/**
 * Sélectionne l'implémentation provider d'un canal. Côté API le provider sert
 * à VALIDER (HMAC) et PARSER les événements entrants (l'envoi est dans le
 * worker). Le provider Meta est construit paresseusement depuis l'environnement
 * (secrets injectés — jamais lus dans le package pur).
 */
@Injectable()
export class WhatsAppProviderFactory {
  private readonly mock = new MockWhatsAppProvider();
  private meta?: MetaCloudWhatsAppProvider;

  constructor(private readonly configService: ConfigService) {}

  getProvider(provider: WhatsAppProviderType): WhatsAppProvider {
    if (provider === 'MOCK') {
      return this.mock;
    }
    if (provider === 'META_CLOUD') {
      return this.getMetaProvider();
    }
    throw new WhatsAppProviderNotImplementedError(provider);
  }

  /** Instance Meta partagée (App Secret pour HMAC ; token pour health/test). */
  getMetaProvider(): MetaCloudWhatsAppProvider {
    if (!this.meta) {
      this.meta = new MetaCloudWhatsAppProvider({
        appSecret: this.configService.get<string>('META_APP_SECRET'),
        accessToken: this.configService.get<string>('META_ACCESS_TOKEN'),
        phoneNumberId: this.configService.get<string>('META_PHONE_NUMBER_ID'),
        graphApiVersion: this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v21.0',
        graphBaseUrl:
          this.configService.get<string>('META_GRAPH_API_BASE_URL') ?? 'https://graph.facebook.com',
        requestTimeoutMs: this.configService.get<number>('META_REQUEST_TIMEOUT_MS'),
      });
    }
    return this.meta;
  }

  /** Meta est-il configuré (App Secret présent) ? Le mock reste sinon disponible. */
  isMetaConfigured(): boolean {
    const secret = this.configService.get<string>('META_APP_SECRET');
    return typeof secret === 'string' && secret.length > 0;
  }
}
