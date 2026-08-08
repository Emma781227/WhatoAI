import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WhatsAppProviderType } from '@whauto/database';
import {
  WhatsAppConnectionNotResolvedError,
  WhatsAppProviderNotImplementedError,
} from '@whauto/shared';
import { MetaCloudWhatsAppProvider, MockWhatsAppProvider } from '@whauto/whatsapp';
import type { WhatsAppProvider } from '@whauto/whatsapp';

import { SecretsEncryptionService } from '../crypto/secrets-encryption.service';
import { PrismaService } from '../prisma/prisma.service';

const ACTIVE_CONNECTION_STATUSES = ['CONNECTING', 'CONNECTED', 'SUSPENDED'] as const;

/**
 * Sélectionne l'implémentation provider d'un canal côté worker (envoi réel).
 *
 * MULTI-TENANT (P1-G3) : quand `META_MULTI_TENANT_ENABLED` est actif, un canal
 * META_CLOUD est résolu depuis la CONNEXION active du Shop → credential DÉCHIFFRÉ
 * + `phone_number_id` du numéro. Le secret d'App (HMAC) et la config Graph restent
 * au niveau App (env) ; seuls le TOKEN et le numéro sont par-tenant. Providers
 * résolus mis en cache par credential (TTL) — jamais de déchiffrement à chaque
 * envoi. Aucune connexion résolvable → ÉCHEC explicite (jamais d'envoi depuis le
 * mauvais numéro). Flag inactif → comportement PILOTE inchangé (config env).
 */
@Injectable()
export class WhatsAppProviderFactory {
  private readonly mock: MockWhatsAppProvider;
  private envMeta?: MetaCloudWhatsAppProvider;
  private readonly tenantCache = new Map<string, { provider: MetaCloudWhatsAppProvider; expiresAt: number }>();
  private readonly multiTenantEnabled: boolean;
  private readonly cacheTtlMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsEncryptionService,
  ) {
    this.mock = new MockWhatsAppProvider({
      deliveryDelayMs: configService.get<number>('WHATSAPP_MOCK_DELIVERY_DELAY_MS') ?? 1500,
      readDelayMs: configService.get<number>('WHATSAPP_MOCK_READ_DELAY_MS') ?? 2000,
    });
    this.multiTenantEnabled = configService.get('META_MULTI_TENANT_ENABLED') === true;
    this.cacheTtlMs = configService.get<number>('META_PROVIDER_CACHE_TTL_MS') ?? 300000;
  }

  /**
   * Provider PILOTE (mock ou Meta env) — usage historique/backward-compat
   * (simulation de statuts, chemins non multi-tenant). Ne résout jamais de
   * credential par-tenant.
   */
  getProvider(provider: WhatsAppProviderType): WhatsAppProvider {
    if (provider === 'MOCK') {
      return this.mock;
    }
    if (provider === 'META_CLOUD') {
      return this.getEnvMetaProvider();
    }
    throw new WhatsAppProviderNotImplementedError(provider);
  }

  /**
   * Provider d'un canal donné. Point d'entrée de l'ENVOI : résout les credentials
   * par Shop en mode multi-tenant, sinon retombe sur le pilote env.
   */
  async getProviderForChannel(channel: {
    provider: WhatsAppProviderType;
    organizationId: string;
    shopId: string;
  }): Promise<WhatsAppProvider> {
    if (channel.provider === 'MOCK') {
      return this.mock;
    }
    if (channel.provider !== 'META_CLOUD') {
      throw new WhatsAppProviderNotImplementedError(channel.provider);
    }
    if (!this.multiTenantEnabled) {
      return this.getEnvMetaProvider();
    }
    return this.resolveTenantMetaProvider(channel.organizationId, channel.shopId);
  }

  private async resolveTenantMetaProvider(
    organizationId: string,
    shopId: string,
  ): Promise<MetaCloudWhatsAppProvider> {
    const connection = await this.prisma.whatsAppConnection.findFirst({
      where: { organizationId, shopId, status: { in: [...ACTIVE_CONNECTION_STATUSES] } },
      select: {
        phoneNumber: { select: { phoneNumberId: true } },
        credential: { select: { id: true, accessTokenEncrypted: true, status: true } },
      },
    });
    if (!connection || connection.credential.status !== 'ACTIVE') {
      // Jamais de repli silencieux sur le pilote : envoyer depuis un autre numéro
      // serait une fuite cross-tenant. On échoue (le message passera FAILED).
      throw new WhatsAppConnectionNotResolvedError(shopId);
    }

    const cached = this.tenantCache.get(connection.credential.id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.provider;
    }

    const accessToken = this.secrets.decrypt(connection.credential.accessTokenEncrypted);
    const provider = new MetaCloudWhatsAppProvider({
      // Niveau App (partagé) : jamais par-tenant.
      appSecret: this.configService.get<string>('META_APP_SECRET'),
      graphApiVersion: this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v21.0',
      graphBaseUrl:
        this.configService.get<string>('META_GRAPH_API_BASE_URL') ?? 'https://graph.facebook.com',
      requestTimeoutMs: this.configService.get<number>('META_REQUEST_TIMEOUT_MS'),
      // Par-tenant : token déchiffré + numéro de la connexion.
      accessToken,
      phoneNumberId: connection.phoneNumber.phoneNumberId,
    });
    this.tenantCache.set(connection.credential.id, {
      provider,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return provider;
  }

  private getEnvMetaProvider(): MetaCloudWhatsAppProvider {
    if (!this.envMeta) {
      this.envMeta = new MetaCloudWhatsAppProvider({
        appSecret: this.configService.get<string>('META_APP_SECRET'),
        accessToken: this.configService.get<string>('META_ACCESS_TOKEN'),
        phoneNumberId: this.configService.get<string>('META_PHONE_NUMBER_ID'),
        graphApiVersion: this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v21.0',
        graphBaseUrl:
          this.configService.get<string>('META_GRAPH_API_BASE_URL') ?? 'https://graph.facebook.com',
        requestTimeoutMs: this.configService.get<number>('META_REQUEST_TIMEOUT_MS'),
      });
    }
    return this.envMeta;
  }

  /** Accès typé au mock pour la planification des statuts simulés. */
  getMockProvider(): MockWhatsAppProvider {
    return this.mock;
  }
}
