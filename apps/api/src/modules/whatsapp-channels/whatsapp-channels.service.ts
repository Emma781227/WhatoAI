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
} from '@whauto/shared';
import { normalizePhoneNumber, WhatsAppProviderSendError } from '@whauto/whatsapp';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
    private readonly providerFactory: WhatsAppProviderFactory,
    private readonly configService: ConfigService,
  ) {}

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
      const updated = await tx.whatsAppChannel.updateMany({
        where: {
          id: channel.id,
          organizationId: tenant.organizationId,
          status: { in: [...ACTIVE_CHANNEL_STATUSES, 'ERROR'] },
        },
        data: { status: 'DISCONNECTED', disconnectedAt: new Date() },
      });
      if (updated.count !== 1) {
        // Déconnecté concurremment.
        throw new WhatsAppChannelNotFoundError();
      }

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'WHATSAPP_CHANNEL_DISCONNECTED',
          actorUserId: tenant.userId,
          metadata: { channelId: channel.id, shopId, previousStatus: channel.status },
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
