import { Injectable } from '@nestjs/common';
import { NotFoundError } from '@whauto/shared';

import { PrismaService } from '../prisma/prisma.service';
import { SecretsEncryptionService } from '../crypto/secrets-encryption.service';

/**
 * Persistance des credentials Meta multi-tenant (P1-G2). Le TOKEN est CHIFFRÉ au
 * repos via `SecretsEncryptionService` (jamais stocké/loggé/sérialisé en clair) ;
 * le déchiffrement ne sort jamais de la couche serveur. Les identifiants Meta non
 * secrets (business/WABA/numéro) sont upsertés tels quels. Ce service alimente
 * l'Embedded Signup (groupe suivant) et la résolution du provider par Shop.
 */
@Injectable()
export class MetaCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsEncryptionService,
  ) {}

  /** Upsert de l'identité Meta d'une org (Business + WABA). Non secret. */
  async upsertBusinessAccount(input: {
    organizationId: string;
    businessId: string;
    wabaId: string;
    verifiedName?: string | null;
    timezone?: string | null;
    currency?: string | null;
    messagingLimitTier?: string | null;
    status?: string | null;
  }): Promise<{ id: string }> {
    return this.prisma.metaBusinessAccount.upsert({
      where: { organizationId_wabaId: { organizationId: input.organizationId, wabaId: input.wabaId } },
      update: {
        businessId: input.businessId,
        verifiedName: input.verifiedName ?? undefined,
        timezone: input.timezone ?? undefined,
        currency: input.currency ?? undefined,
        messagingLimitTier: input.messagingLimitTier ?? undefined,
        status: input.status ?? undefined,
      },
      create: {
        organizationId: input.organizationId,
        businessId: input.businessId,
        wabaId: input.wabaId,
        verifiedName: input.verifiedName ?? null,
        timezone: input.timezone ?? null,
        currency: input.currency ?? null,
        messagingLimitTier: input.messagingLimitTier ?? null,
        status: input.status ?? null,
      },
      select: { id: true },
    });
  }

  /** Upsert d'un numéro (phone_number_id global côté Meta). Non secret. */
  async upsertPhoneNumber(input: {
    organizationId: string;
    metaBusinessAccountId: string;
    phoneNumberId: string;
    displayPhoneNumber?: string | null;
    verifiedName?: string | null;
    qualityRating?: string | null;
    status?: string | null;
  }): Promise<{ id: string }> {
    return this.prisma.whatsAppPhoneNumber.upsert({
      where: { phoneNumberId: input.phoneNumberId },
      update: {
        displayPhoneNumber: input.displayPhoneNumber ?? undefined,
        verifiedName: input.verifiedName ?? undefined,
        qualityRating: input.qualityRating ?? undefined,
        status: input.status ?? undefined,
      },
      create: {
        organizationId: input.organizationId,
        metaBusinessAccountId: input.metaBusinessAccountId,
        phoneNumberId: input.phoneNumberId,
        displayPhoneNumber: input.displayPhoneNumber ?? null,
        verifiedName: input.verifiedName ?? null,
        qualityRating: input.qualityRating ?? null,
        status: input.status ?? null,
      },
      select: { id: true },
    });
  }

  /**
   * Stocke un token Meta CHIFFRÉ. Le clair `accessToken` n'est jamais persisté ni
   * retourné — seule l'enveloppe est écrite en base (colonne `accessTokenEncrypted`).
   */
  async storeCredential(input: {
    organizationId: string;
    metaBusinessAccountId: string;
    accessToken: string;
    tokenType?: string;
    scopes?: string[];
    expiresAt?: Date | null;
  }): Promise<{ id: string }> {
    const accessTokenEncrypted = this.secrets.encrypt(input.accessToken);
    return this.prisma.metaWhatsAppCredential.create({
      data: {
        organizationId: input.organizationId,
        metaBusinessAccountId: input.metaBusinessAccountId,
        accessTokenEncrypted,
        tokenType: input.tokenType ?? 'SYSTEM_USER',
        scopes: input.scopes ?? [],
        expiresAt: input.expiresAt ?? null,
      },
      select: { id: true },
    });
  }

  /**
   * Déchiffre le token d'un credential (tenant-scopé). Réservé à l'usage SERVEUR
   * (résolution du provider Meta) — ne JAMAIS exposer ni logger le retour.
   */
  async getDecryptedAccessToken(organizationId: string, credentialId: string): Promise<string> {
    const credential = await this.prisma.metaWhatsAppCredential.findFirst({
      where: { id: credentialId, organizationId, status: 'ACTIVE' },
      select: { accessTokenEncrypted: true },
    });
    if (!credential) {
      throw new NotFoundError('Meta credential not found.');
    }
    return this.secrets.decrypt(credential.accessTokenEncrypted);
  }
}
