import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@whauto/database';
import {
  InvalidPhoneNumberError,
  MetaApiError,
  MetaChannelConfigurationError,
  ShopArchivedError,
  ShopNotFoundError,
  WhatsAppChannelAlreadyActiveError,
  WhatsAppChannelNotFoundError,
  WhatsAppConnectionNotResolvedError,
} from '@whauto/shared';
import {
  MetaCloudWhatsAppProvider,
  MetaOnboardingClient,
  normalizePhoneNumber,
  WhatsAppProviderSendError,
} from '@whauto/whatsapp';
import type {
  WhatsAppBusinessProfile,
  WhatsAppBusinessProfileUpdate,
} from '@whauto/whatsapp';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { SecretsEncryptionService } from '../../crypto/secrets-encryption.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import { WhatsAppProviderFactory } from '../whatsapp-inbound/whatsapp-provider.factory';
import {
  ACTIVE_CHANNEL_STATUSES,
  WHATSAPP_CHANNEL_PUBLIC_SELECT,
} from './whatsapp-channels.mapper';
import type { WhatsAppChannelPublic } from './whatsapp-channels.mapper';

export interface CreateMockChannelInput {
  displayName: string;
  phoneNumber: string;
}

export interface MetaChannelHealth {
  ok: boolean;
  provider: string;
  status: string;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  lastWebhookAt: Date | null;
  lastErrorCode: string | null;
}

function isActiveChannelConflict(error: unknown): boolean {
  // Seul P2002 possible ici : l'index partiel whatsapp_channels_one_active_per_shop
  // (la table n'a aucune autre contrainte unique hors PK). Piège connu : le
  // meta.target d'un index partiel brut remonte les colonnes, pas son nom.
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class WhatsAppChannelsService {
  private onboardingClient?: MetaOnboardingClient;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
    private readonly providerFactory: WhatsAppProviderFactory,
    private readonly configService: ConfigService,
    private readonly secrets: SecretsEncryptionService,
  ) {}

  /** Client d'onboarding Meta (Embedded Signup) — config App injectée depuis l'env. */
  private getOnboardingClient(): MetaOnboardingClient {
    if (!this.onboardingClient) {
      this.onboardingClient = new MetaOnboardingClient({
        appId: this.configService.get<string>('META_APP_ID'),
        appSecret: this.configService.get<string>('META_APP_SECRET'),
        graphApiVersion: this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v21.0',
        graphBaseUrl:
          this.configService.get<string>('META_GRAPH_API_BASE_URL') ?? 'https://graph.facebook.com',
        requestTimeoutMs: this.configService.get<number>('META_REQUEST_TIMEOUT_MS'),
      });
    }
    return this.onboardingClient;
  }

  /**
   * Connecte un canal MOCK à une Shop : création + passage direct à CONNECTED
   * (aucun aller-retour OAuth en mock) + audit dans la même transaction.
   * Si un ancien canal ERROR traîne sur la Shop, il est clos (DISCONNECTED,
   * historique conservé) dans la même transaction : créer un nouveau canal
   * EST l'action explicite de remplacement d'un canal en erreur.
   */
  async connectMock(
    tenant: TenantContext,
    shopId: string,
    input: CreateMockChannelInput,
    context: AuditActionContext,
  ): Promise<WhatsAppChannelPublic> {
    const shop = await this.getShopForTenant(tenant, shopId);
    if (shop.status === 'ARCHIVED') {
      throw new ShopArchivedError();
    }

    const normalizedPhone = normalizePhoneNumber(input.phoneNumber);
    if (normalizedPhone === null) {
      throw new InvalidPhoneNumberError();
    }

    const existingActive = await this.prisma.whatsAppChannel.findFirst({
      where: { shopId, status: { in: [...ACTIVE_CHANNEL_STATUSES] } },
      select: { id: true },
    });
    if (existingActive) {
      throw new WhatsAppChannelAlreadyActiveError();
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();

        // Remplacement explicite d'un éventuel canal ERROR (slot déjà libre).
        await tx.whatsAppChannel.updateMany({
          where: { shopId, organizationId: tenant.organizationId, status: 'ERROR' },
          data: { status: 'DISCONNECTED', disconnectedAt: now },
        });

        const channel = await tx.whatsAppChannel.create({
          data: {
            organizationId: tenant.organizationId,
            shopId,
            provider: 'MOCK',
            status: 'CONNECTED',
            displayName: input.displayName.trim(),
            phoneNumber: normalizedPhone,
            connectedAt: now,
          },
          select: WHATSAPP_CHANNEL_PUBLIC_SELECT,
        });

        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'WHATSAPP_CHANNEL_CONNECTED',
            actorUserId: tenant.userId,
            metadata: { channelId: channel.id, shopId, provider: 'MOCK' },
            context,
          },
          tx,
        );

        return channel;
      });
    } catch (error) {
      if (isActiveChannelConflict(error)) {
        // Course avec une connexion concurrente : l'index partiel a tranché.
        throw new WhatsAppChannelAlreadyActiveError();
      }
      throw error;
    }
  }

  /**
   * Canal courant d'une Shop : le canal actif s'il existe, sinon le dernier
   * canal ERROR (l'UI doit pouvoir afficher l'état d'erreur et proposer le
   * remplacement). Les canaux DISCONNECTED ne sont jamais retournés.
   */
  async getForShop(tenant: TenantContext, shopId: string): Promise<WhatsAppChannelPublic> {
    await this.getShopForTenant(tenant, shopId);

    const active = await this.prisma.whatsAppChannel.findFirst({
      where: {
        shopId,
        organizationId: tenant.organizationId,
        status: { in: [...ACTIVE_CHANNEL_STATUSES] },
      },
      select: WHATSAPP_CHANNEL_PUBLIC_SELECT,
    });
    if (active) {
      return active;
    }

    const lastError = await this.prisma.whatsAppChannel.findFirst({
      where: { shopId, organizationId: tenant.organizationId, status: 'ERROR' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: WHATSAPP_CHANNEL_PUBLIC_SELECT,
    });
    if (lastError) {
      return lastError;
    }

    throw new WhatsAppChannelNotFoundError();
  }

  /**
   * Déconnexion : transition conditionnelle vers DISCONNECTED (terminal,
   * libère le slot actif de la Shop). Fonctionne aussi sur un canal ERROR
   * ("réparation" = le clore explicitement). Idempotence : un canal déjà
   * déconnecté → 404 (il n'y a plus de canal courant).
   *
   * MULTI-TENANT : clôt AUSSI la connexion Meta de la Shop et RÉVOQUE le
   * credential (token chiffré). Sécurité : un commerçant déconnecté ne doit plus
   * disposer d'un token utilisable — le worker refuse alors tout envoi (aucune
   * connexion active résolvable). Sans effet sur MOCK/pilote (aucune connexion).
   */
  async disconnect(
    tenant: TenantContext,
    shopId: string,
    context: AuditActionContext,
  ): Promise<WhatsAppChannelPublic> {
    await this.getShopForTenant(tenant, shopId);

    const channel = await this.prisma.whatsAppChannel.findFirst({
      where: {
        shopId,
        organizationId: tenant.organizationId,
        status: { in: [...ACTIVE_CHANNEL_STATUSES, 'ERROR'] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true },
    });
    if (!channel) {
      throw new WhatsAppChannelNotFoundError();
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const updated = await tx.whatsAppChannel.updateMany({
        where: {
          id: channel.id,
          organizationId: tenant.organizationId,
          status: { in: [...ACTIVE_CHANNEL_STATUSES, 'ERROR'] },
        },
        data: { status: 'DISCONNECTED', disconnectedAt: now },
      });
      if (updated.count !== 1) {
        // Déconnecté concurremment.
        throw new WhatsAppChannelNotFoundError();
      }

      const teardown = await this.teardownActiveConnections(tx, tenant.organizationId, shopId, now);

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'WHATSAPP_CHANNEL_DISCONNECTED',
          actorUserId: tenant.userId,
          metadata: {
            channelId: channel.id,
            shopId,
            previousStatus: channel.status,
            connectionsClosed: teardown.connectionsClosed,
            credentialsRevoked: teardown.credentialsRevoked,
          },
          context,
        },
        tx,
      );

      return tx.whatsAppChannel.findUniqueOrThrow({
        where: { id: channel.id },
        select: WHATSAPP_CHANNEL_PUBLIC_SELECT,
      });
    });
  }

  /**
   * Clôt toutes les connexions Meta actives d'une Shop et révoque leurs
   * credentials (token chiffré inutilisable ensuite). Idempotent et no-op quand
   * il n'y a aucune connexion (MOCK/pilote). À exécuter DANS une transaction.
   */
  private async teardownActiveConnections(
    tx: Prisma.TransactionClient,
    organizationId: string,
    shopId: string,
    now: Date,
  ): Promise<{ connectionsClosed: number; credentialsRevoked: number }> {
    const active = await tx.whatsAppConnection.findMany({
      where: { organizationId, shopId, status: { in: [...ACTIVE_CHANNEL_STATUSES] } },
      select: { id: true, metaWhatsAppCredentialId: true },
    });
    if (active.length === 0) {
      return { connectionsClosed: 0, credentialsRevoked: 0 };
    }

    const closed = await tx.whatsAppConnection.updateMany({
      where: { id: { in: active.map((c) => c.id) } },
      data: { status: 'DISCONNECTED', disconnectedAt: now },
    });
    // Révocation locale du token : le worker ne résout que des credentials ACTIVE.
    // (La révocation côté Meta reste un appel Graph externe hors périmètre ici.)
    const revoked = await tx.metaWhatsAppCredential.updateMany({
      where: {
        organizationId,
        id: { in: active.map((c) => c.metaWhatsAppCredentialId) },
        status: { not: 'REVOKED' },
      },
      data: { status: 'REVOKED', revokedAt: now },
    });
    return { connectionsClosed: closed.count, credentialsRevoked: revoked.count };
  }

  /**
   * Connecte le canal Meta PILOTE d'une Shop : la configuration (phoneNumberId,
   * secrets) vient de l'environnement (validé D3 — aucun secret en base). Vérifie
   * la config via Graph (aucun envoi), enregistre les infos NON secrètes, passe
   * CONNECTED. Un seul canal actif par Shop (comme le mock).
   */
  async connectMeta(
    tenant: TenantContext,
    shopId: string,
    input: { displayName?: string },
    context: AuditActionContext,
  ): Promise<WhatsAppChannelPublic> {
    const shop = await this.getShopForTenant(tenant, shopId);
    if (shop.status === 'ARCHIVED') {
      throw new ShopArchivedError();
    }
    if (!this.providerFactory.isMetaConfigured()) {
      throw new MetaChannelConfigurationError();
    }
    const phoneNumberId = this.configService.get<string>('META_PHONE_NUMBER_ID');
    const wabaId = this.configService.get<string>('META_WABA_ID') ?? null;
    if (!phoneNumberId) {
      throw new MetaChannelConfigurationError();
    }

    // Vérifie la configuration côté Meta (GET Graph — aucun envoi de message).
    const info = await this.validateMetaOrThrow(tenant, shopId, context);

    const existingActive = await this.prisma.whatsAppChannel.findFirst({
      where: { shopId, status: { in: [...ACTIVE_CHANNEL_STATUSES] } },
      select: { id: true },
    });
    if (existingActive) {
      throw new WhatsAppChannelAlreadyActiveError();
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.whatsAppChannel.updateMany({
          where: { shopId, organizationId: tenant.organizationId, status: 'ERROR' },
          data: { status: 'DISCONNECTED', disconnectedAt: now },
        });

        const channel = await tx.whatsAppChannel.create({
          data: {
            organizationId: tenant.organizationId,
            shopId,
            provider: 'META_CLOUD',
            status: 'CONNECTED',
            displayName: (input.displayName ?? info.verifiedName ?? 'WhatsApp Business').trim(),
            // phoneNumber = numéro affiché (l'envoi utilise phoneNumberId, jamais ce champ).
            phoneNumber: info.displayPhoneNumber ?? phoneNumberId,
            phoneNumberId,
            wabaId,
            displayPhoneNumber: info.displayPhoneNumber ?? null,
            verifiedName: info.verifiedName ?? null,
            connectedAt: now,
          },
          select: WHATSAPP_CHANNEL_PUBLIC_SELECT,
        });

        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'META_CHANNEL_CONNECTED',
            actorUserId: tenant.userId,
            // Aucun secret : uniquement des identifiants non sensibles.
            metadata: { channelId: channel.id, shopId, phoneNumberId },
            context,
          },
          tx,
        );
        return channel;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new WhatsAppChannelAlreadyActiveError();
      }
      throw error;
    }
  }

  /**
   * Embedded Signup (P1-G4) : provisionne une connexion WhatsApp par-tenant à
   * partir du `code` renvoyé par Meta. Séquence : échange OAuth → abonnement de
   * l'App à la WABA → lecture du numéro (appels Graph EXTERNES) puis, dans UNE
   * transaction : stockage du token CHIFFRÉ (jamais en clair/log/réponse),
   * business/numéro, connexion active (remplace l'ancienne) et WhatsAppChannel
   * opérationnel CONNECTED. Le retour ne contient JAMAIS de secret.
   */
  async onboard(
    tenant: TenantContext,
    shopId: string,
    input: { code: string; wabaId: string; phoneNumberId: string; businessId: string },
    context: AuditActionContext,
  ): Promise<WhatsAppChannelPublic> {
    if (this.configService.get('META_MULTI_TENANT_ENABLED') !== true || !this.secrets.isConfigured()) {
      throw new MetaChannelConfigurationError();
    }
    const shop = await this.getShopForTenant(tenant, shopId);
    if (shop.status === 'ARCHIVED') {
      throw new ShopArchivedError();
    }

    // Appels Graph EXTERNES (hors transaction) — via le VRAI client d'onboarding.
    const client = this.getOnboardingClient();
    let accessTokenEncrypted: string;
    let expiresAt: Date | null;
    let facebookUserId: string | null = null;
    let phone: { displayPhoneNumber: string | null; verifiedName: string | null; qualityRating: string | null };
    try {
      const token = await client.exchangeCodeForToken(input.code);
      await client.subscribeApp(input.wabaId, token.accessToken);
      phone = await client.getPhoneNumber(input.phoneNumberId, token.accessToken);
      // ID FB de l'auteur (best-effort) : rattache les callbacks Meta au commerçant.
      facebookUserId = (await client.getAuthenticatedUser(token.accessToken).catch(() => null))?.id ?? null;
      // Chiffrement immédiat : le clair ne quitte jamais cette portée.
      accessTokenEncrypted = this.secrets.encrypt(token.accessToken);
      expiresAt = token.expiresInSeconds ? new Date(Date.now() + token.expiresInSeconds * 1000) : null;
    } catch (error) {
      throw new MetaApiError(error instanceof Error ? error.message : 'Meta onboarding failed.');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const businessAccount = await tx.metaBusinessAccount.upsert({
          where: { organizationId_wabaId: { organizationId: tenant.organizationId, wabaId: input.wabaId } },
          update: { businessId: input.businessId, verifiedName: phone.verifiedName ?? undefined },
          create: {
            organizationId: tenant.organizationId,
            businessId: input.businessId,
            wabaId: input.wabaId,
            verifiedName: phone.verifiedName ?? null,
          },
          select: { id: true },
        });

        const credential = await tx.metaWhatsAppCredential.create({
          data: {
            organizationId: tenant.organizationId,
            metaBusinessAccountId: businessAccount.id,
            accessTokenEncrypted,
            tokenType: 'SYSTEM_USER',
            scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
            expiresAt,
            facebookUserId,
            status: 'ACTIVE',
          },
          select: { id: true },
        });

        const phoneNumber = await tx.whatsAppPhoneNumber.upsert({
          where: { phoneNumberId: input.phoneNumberId },
          update: {
            displayPhoneNumber: phone.displayPhoneNumber ?? undefined,
            verifiedName: phone.verifiedName ?? undefined,
            qualityRating: phone.qualityRating ?? undefined,
          },
          create: {
            organizationId: tenant.organizationId,
            metaBusinessAccountId: businessAccount.id,
            phoneNumberId: input.phoneNumberId,
            displayPhoneNumber: phone.displayPhoneNumber ?? null,
            verifiedName: phone.verifiedName ?? null,
            qualityRating: phone.qualityRating ?? null,
          },
          select: { id: true },
        });

        // Reconnexion : clôt l'active précédente (index partiel une active/Shop)
        // ET révoque son ancien token — jamais deux credentials vivants pour la
        // même Shop. Le NOUVEAU credential créé ci-dessus n'est pas concerné
        // (aucune connexion active ne le référence encore).
        const superseded = await this.teardownActiveConnections(
          tx,
          tenant.organizationId,
          shopId,
          now,
        );
        const connection = await tx.whatsAppConnection.create({
          data: {
            organizationId: tenant.organizationId,
            shopId,
            whatsAppPhoneNumberId: phoneNumber.id,
            metaWhatsAppCredentialId: credential.id,
            status: 'CONNECTED',
            connectedAt: now,
          },
          select: { id: true },
        });

        // Canal opérationnel : clôt l'actif précédent puis crée META_CLOUD CONNECTED.
        await tx.whatsAppChannel.updateMany({
          where: { organizationId: tenant.organizationId, shopId, status: { in: [...ACTIVE_CHANNEL_STATUSES] } },
          data: { status: 'DISCONNECTED', disconnectedAt: now },
        });
        const channel = await tx.whatsAppChannel.create({
          data: {
            organizationId: tenant.organizationId,
            shopId,
            provider: 'META_CLOUD',
            status: 'CONNECTED',
            displayName: (phone.verifiedName ?? 'WhatsApp Business').trim(),
            phoneNumber: phone.displayPhoneNumber ?? input.phoneNumberId,
            phoneNumberId: input.phoneNumberId,
            wabaId: input.wabaId,
            businessId: input.businessId,
            displayPhoneNumber: phone.displayPhoneNumber ?? null,
            verifiedName: phone.verifiedName ?? null,
            connectedAt: now,
          },
          select: WHATSAPP_CHANNEL_PUBLIC_SELECT,
        });

        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'META_CHANNEL_CONNECTED',
            actorUserId: tenant.userId,
            // Jamais de secret : seulement des identifiants non sensibles.
            metadata: {
              channelId: channel.id,
              connectionId: connection.id,
              shopId,
              phoneNumberId: input.phoneNumberId,
              wabaId: input.wabaId,
              // Reconnexion : nombre d'anciens tokens révoqués (0 = 1ʳᵉ connexion).
              supersededCredentialsRevoked: superseded.credentialsRevoked,
            },
            context,
          },
          tx,
        );
        return channel;
      });
    } catch (error) {
      if (isActiveChannelConflict(error)) {
        throw new WhatsAppChannelAlreadyActiveError();
      }
      throw error;
    }
  }

  /**
   * Santé de la config Meta — GET Graph uniquement, JAMAIS d'envoi (validé D19).
   * Ne renvoie aucun secret. Échec → statut ok:false + audit META_CHANNEL_ERROR,
   * jamais une exception non filtrée.
   */
  async metaHealth(
    tenant: TenantContext,
    shopId: string,
    context: AuditActionContext,
  ): Promise<MetaChannelHealth> {
    const channel = await this.getMetaChannel(tenant, shopId);
    if (!this.providerFactory.isMetaConfigured()) {
      throw new MetaChannelConfigurationError();
    }

    try {
      const info = await this.providerFactory.getMetaProvider().validateConfiguration();
      await this.auditService.recordSafe({
        organizationId: tenant.organizationId,
        eventType: 'META_CHANNEL_TESTED',
        actorUserId: tenant.userId,
        metadata: { channelId: channel.id, shopId, ok: true },
        context,
      });
      return {
        ok: true,
        provider: channel.provider,
        status: channel.status,
        phoneNumberId: channel.phoneNumberId,
        displayPhoneNumber: info.displayPhoneNumber ?? channel.displayPhoneNumber,
        verifiedName: info.verifiedName ?? channel.verifiedName,
        lastWebhookAt: channel.lastWebhookAt,
        lastErrorCode: channel.lastErrorCode,
      };
    } catch (error) {
      const code = error instanceof WhatsAppProviderSendError ? error.code : 'META_HEALTH_FAILED';
      await this.prisma.whatsAppChannel
        .update({
          where: { id: channel.id },
          data: { lastErrorCode: code, lastErrorMessage: 'Meta health check failed.' },
        })
        .catch(() => undefined);
      await this.auditService.recordSafe({
        organizationId: tenant.organizationId,
        eventType: 'META_CHANNEL_ERROR',
        actorUserId: tenant.userId,
        metadata: { channelId: channel.id, shopId, code },
        context,
      });
      return {
        ok: false,
        provider: channel.provider,
        status: channel.status,
        phoneNumberId: channel.phoneNumberId,
        displayPhoneNumber: channel.displayPhoneNumber,
        verifiedName: channel.verifiedName,
        lastWebhookAt: channel.lastWebhookAt,
        lastErrorCode: code,
      };
    }
  }

  /**
   * Envoi de test RÉEL — action explicite (confirm=true, validé au DTO). C'est
   * un diagnostic de connectivité, distinct du flux conversationnel : il appelle
   * directement le provider et NE crée pas de Message persisté. Ne renvoie que
   * le providerMessageId (aucune réponse provider brute).
   */
  async sendTestMessage(
    tenant: TenantContext,
    shopId: string,
    input: { to: string; text: string },
    context: AuditActionContext,
  ): Promise<{ providerMessageId: string }> {
    const channel = await this.getMetaChannel(tenant, shopId);
    if (!this.providerFactory.isMetaConfigured()) {
      throw new MetaChannelConfigurationError();
    }
    const normalized = normalizePhoneNumber(input.to);
    if (normalized === null) {
      throw new InvalidPhoneNumberError();
    }

    try {
      const result = await this.providerFactory.getMetaProvider().sendTextMessage({
        channel: { id: channel.id, phoneNumber: channel.phoneNumber },
        to: normalized,
        text: input.text,
        dispatchId: `test.${randomUUID()}`,
      });
      await this.auditService.recordSafe({
        organizationId: tenant.organizationId,
        eventType: 'META_CHANNEL_TESTED',
        actorUserId: tenant.userId,
        metadata: { channelId: channel.id, shopId, testSend: true },
        context,
      });
      return { providerMessageId: result.externalMessageId };
    } catch (error) {
      const code = error instanceof WhatsAppProviderSendError ? error.code : 'META_TEST_SEND_FAILED';
      throw new MetaApiError(code);
    }
  }

  /**
   * Lit le profil WhatsApp Business du canal Meta de la Shop (GET Graph, aucun
   * envoi). En multi-tenant le token du commerçant est utilisé ; sinon le
   * provider pilote (env). Aucun secret renvoyé.
   */
  async getBusinessProfile(
    tenant: TenantContext,
    shopId: string,
  ): Promise<WhatsAppBusinessProfile> {
    await this.getMetaChannel(tenant, shopId);
    const provider = await this.resolveMetaProviderForShop(tenant.organizationId, shopId);
    try {
      return await provider.getBusinessProfile();
    } catch (error) {
      throw this.toMetaApiError(error);
    }
  }

  /**
   * Met à jour le profil WhatsApp Business puis relit l'état frais. Audit
   * `META_PROFILE_UPDATED` avec la LISTE des champs modifiés (jamais leur
   * contenu) dans la même logique que SHOP_UPDATED.
   */
  async updateBusinessProfile(
    tenant: TenantContext,
    shopId: string,
    input: WhatsAppBusinessProfileUpdate,
    context: AuditActionContext,
  ): Promise<WhatsAppBusinessProfile> {
    const channel = await this.getMetaChannel(tenant, shopId);
    const provider = await this.resolveMetaProviderForShop(tenant.organizationId, shopId);

    // Ne conserve que les champs réellement fournis (undefined = inchangé).
    const update: WhatsAppBusinessProfileUpdate = {};
    const fields: Array<keyof WhatsAppBusinessProfileUpdate> = [
      'about',
      'address',
      'description',
      'email',
      'vertical',
      'websites',
    ];
    for (const field of fields) {
      if (input[field] !== undefined) {
        (update as Record<string, unknown>)[field] = input[field];
      }
    }
    const changedFields = Object.keys(update);

    try {
      await provider.updateBusinessProfile(update);
      const profile = await provider.getBusinessProfile();
      await this.auditService.recordSafe({
        organizationId: tenant.organizationId,
        eventType: 'META_PROFILE_UPDATED',
        actorUserId: tenant.userId,
        // Jamais le contenu : uniquement les noms de champs modifiés.
        metadata: { channelId: channel.id, shopId, changedFields },
        context,
      });
      return profile;
    } catch (error) {
      throw this.toMetaApiError(error);
    }
  }

  /** Traduit une erreur provider Meta en MetaApiError (code non sensible). */
  private toMetaApiError(error: unknown): MetaApiError {
    const code = error instanceof WhatsAppProviderSendError ? error.code : 'META_PROFILE_FAILED';
    return new MetaApiError(code);
  }

  /**
   * Résout le provider Meta à utiliser pour une Shop. Multi-tenant : token
   * DÉCHIFFRÉ + phone_number_id de la connexion active (jamais de repli sur un
   * autre numéro — fuite cross-tenant). Pilote : provider env partagé.
   */
  private async resolveMetaProviderForShop(
    organizationId: string,
    shopId: string,
  ): Promise<MetaCloudWhatsAppProvider> {
    if (this.configService.get('META_MULTI_TENANT_ENABLED') !== true) {
      if (!this.providerFactory.isMetaConfigured()) {
        throw new MetaChannelConfigurationError();
      }
      return this.providerFactory.getMetaProvider();
    }
    if (!this.secrets.isConfigured()) {
      throw new MetaChannelConfigurationError();
    }
    const connection = await this.prisma.whatsAppConnection.findFirst({
      where: { organizationId, shopId, status: { in: [...ACTIVE_CHANNEL_STATUSES] } },
      select: {
        phoneNumber: { select: { phoneNumberId: true } },
        credential: { select: { accessTokenEncrypted: true, status: true } },
      },
    });
    if (!connection || connection.credential.status !== 'ACTIVE') {
      throw new WhatsAppConnectionNotResolvedError(shopId);
    }
    const accessToken = this.secrets.decrypt(connection.credential.accessTokenEncrypted);
    return new MetaCloudWhatsAppProvider({
      appSecret: this.configService.get<string>('META_APP_SECRET'),
      graphApiVersion: this.configService.get<string>('META_GRAPH_API_VERSION') ?? 'v21.0',
      graphBaseUrl:
        this.configService.get<string>('META_GRAPH_API_BASE_URL') ?? 'https://graph.facebook.com',
      requestTimeoutMs: this.configService.get<number>('META_REQUEST_TIMEOUT_MS'),
      accessToken,
      phoneNumberId: connection.phoneNumber.phoneNumberId,
    });
  }

  private async validateMetaOrThrow(
    tenant: TenantContext,
    shopId: string,
    context: AuditActionContext,
  ): Promise<{ displayPhoneNumber?: string; verifiedName?: string }> {
    try {
      return await this.providerFactory.getMetaProvider().validateConfiguration();
    } catch (error) {
      const code = error instanceof WhatsAppProviderSendError ? error.code : 'META_VALIDATION_FAILED';
      await this.auditService.recordSafe({
        organizationId: tenant.organizationId,
        eventType: 'META_CHANNEL_ERROR',
        actorUserId: tenant.userId,
        metadata: { shopId, code },
        context,
      });
      throw new MetaChannelConfigurationError();
    }
  }

  private async getMetaChannel(
    tenant: TenantContext,
    shopId: string,
  ): Promise<WhatsAppChannelPublic> {
    await this.getShopForTenant(tenant, shopId);
    const channel = await this.prisma.whatsAppChannel.findFirst({
      where: {
        shopId,
        organizationId: tenant.organizationId,
        provider: 'META_CLOUD',
        status: { in: [...ACTIVE_CHANNEL_STATUSES] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: WHATSAPP_CHANNEL_PUBLIC_SELECT,
    });
    if (!channel) {
      throw new WhatsAppChannelNotFoundError();
    }
    return channel;
  }

  private async getShopForTenant(tenant: TenantContext, shopId: string) {
    const shop = await this.prisma.shop.findFirst({
      where: { id: shopId, organizationId: tenant.organizationId },
      select: { id: true, status: true },
    });
    if (!shop) {
      throw new ShopNotFoundError();
    }
    return shop;
  }
}
