import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WhatsAppProviderType } from '@whauto/database';
import { WhatsAppProviderNotImplementedError } from '@whauto/shared';
import { MetaCloudWhatsAppProvider, MockWhatsAppProvider } from '@whauto/whatsapp';
import type { WhatsAppProvider } from '@whauto/whatsapp';

/**
 * Sélectionne l'implémentation provider d'un canal côté worker (envoi réel).
 * Le mock simule les statuts (délais env) ; Meta envoie via l'API Graph
 * (secrets injectés depuis l'environnement — jamais lus dans le package pur).
 */
@Injectable()
export class WhatsAppProviderFactory {
  private readonly mock: MockWhatsAppProvider;
  private meta?: MetaCloudWhatsAppProvider;

  constructor(private readonly configService: ConfigService) {
    this.mock = new MockWhatsAppProvider({
      deliveryDelayMs: configService.get<number>('WHATSAPP_MOCK_DELIVERY_DELAY_MS') ?? 1500,
      readDelayMs: configService.get<number>('WHATSAPP_MOCK_READ_DELAY_MS') ?? 2000,
    });
  }

  getProvider(provider: WhatsAppProviderType): WhatsAppProvider {
    if (provider === 'MOCK') {
      return this.mock;
    }
    if (provider === 'META_CLOUD') {
      return this.getMetaProvider();
    }
    throw new WhatsAppProviderNotImplementedError(provider);
  }

  private getMetaProvider(): MetaCloudWhatsAppProvider {
    if (!this.meta) {
      this.meta = new MetaCloudWhatsAppProvider({
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

  /** Accès typé au mock pour la planification des statuts simulés. */
  getMockProvider(): MockWhatsAppProvider {
    return this.mock;
  }
}
