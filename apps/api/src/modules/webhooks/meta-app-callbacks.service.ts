import { randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaWebhookSignatureError } from '@whauto/shared';
import { parseMetaSignedRequest } from '@whauto/whatsapp';

import { PrismaService } from '../../prisma/prisma.service';

const ACTIVE_STATUSES = ['CONNECTING', 'CONNECTED', 'SUSPENDED'] as const;

/**
 * Callbacks Meta d'App Review (PUBLICS, aucun guard tenant) :
 * - Deauthorize : l'utilisateur/business retire l'App → on démantèle ses
 *   connexions et RÉVOQUE ses tokens (comme une déconnexion, mais déclenchée
 *   par Meta) ;
 * - Data Deletion : on révoque les credentials Meta du user, on trace la demande
 *   et on renvoie le `{ url, confirmation_code }` exigé par Meta.
 *
 * Le `signed_request` (HMAC-SHA256 avec l'App Secret) est l'AUTORITÉ : une
 * signature invalide → 401, aucune action. Le rattachement au commerçant se fait
 * par l'ID utilisateur Facebook capturé à l'onboarding.
 */
@Injectable()
export class MetaAppCallbacksService {
  private readonly logger = new Logger(MetaAppCallbacksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private appSecret(): string | undefined {
    return this.config.get<string>('META_APP_SECRET');
  }

  /** Deauthorize : signature vérifiée → teardown des connexions du user. */
  async handleDeauthorize(signedRequest: string | undefined): Promise<{ success: true }> {
    const payload = parseMetaSignedRequest(signedRequest, this.appSecret());
    if (!payload) {
      throw new MetaWebhookSignatureError();
    }
    if (payload.user_id) {
      const result = await this.teardownByFacebookUser(payload.user_id);
      this.logger.log(
        `Deauthorize Meta : ${result.connectionsClosed} connexion(s) close(s), ${result.credentialsRevoked} token(s) révoqué(s).`,
      );
    }
    return { success: true };
  }

  /**
   * Data Deletion : signature vérifiée → révocation des credentials Meta du user
   * + trace durable, puis renvoi du format Meta { url, confirmation_code }.
   */
  async handleDataDeletion(
    signedRequest: string | undefined,
  ): Promise<{ url: string; confirmation_code: string }> {
    const payload = parseMetaSignedRequest(signedRequest, this.appSecret());
    if (!payload) {
      throw new MetaWebhookSignatureError();
    }
    const facebookUserId = payload.user_id ?? 'unknown';
    const confirmationCode = randomBytes(16).toString('hex');

    const teardown = payload.user_id
      ? await this.teardownByFacebookUser(payload.user_id)
      : { connectionsClosed: 0, credentialsRevoked: 0 };

    await this.prisma.metaDataDeletionRequest.create({
      data: {
        confirmationCode,
        facebookUserId,
        status: 'PROCESSED',
        credentialsRevoked: teardown.credentialsRevoked,
        processedAt: new Date(),
      },
    });

    const base = this.config.get<string>('API_PUBLIC_URL') ?? 'http://localhost:4000';
    return {
      url: `${base}/api/webhooks/whatsapp/meta/data-deletion/status?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    };
  }

  /** Statut d'une demande de suppression — URL publique consultable par l'utilisateur. */
  async getDeletionStatus(code: string | undefined): Promise<{ status: string; confirmation_code: string }> {
    if (!code) {
      return { status: 'not_found', confirmation_code: '' };
    }
    const req = await this.prisma.metaDataDeletionRequest.findUnique({
      where: { confirmationCode: code },
      select: { status: true, confirmationCode: true },
    });
    if (!req) {
      return { status: 'not_found', confirmation_code: code };
    }
    return {
      status: req.status === 'PROCESSED' ? 'completed' : 'pending',
      confirmation_code: req.confirmationCode,
    };
  }

  /**
   * Démantèle toutes les connexions Meta actives d'un utilisateur Facebook et
   * révoque leurs tokens (transaction). Idempotent : sans credential ACTIVE →
   * no-op. Ferme aussi le WhatsAppChannel opérationnel de chaque connexion.
   */
  private async teardownByFacebookUser(
    facebookUserId: string,
  ): Promise<{ connectionsClosed: number; credentialsRevoked: number }> {
    return this.prisma.$transaction(async (tx) => {
      const creds = await tx.metaWhatsAppCredential.findMany({
        where: { facebookUserId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (creds.length === 0) {
        return { connectionsClosed: 0, credentialsRevoked: 0 };
      }
      const credIds = creds.map((c) => c.id);

      const conns = await tx.whatsAppConnection.findMany({
        where: { metaWhatsAppCredentialId: { in: credIds }, status: { in: [...ACTIVE_STATUSES] } },
        select: { id: true, shopId: true, organizationId: true },
      });
      const now = new Date();
      if (conns.length > 0) {
        await tx.whatsAppConnection.updateMany({
          where: { id: { in: conns.map((c) => c.id) } },
          data: { status: 'DISCONNECTED', disconnectedAt: now },
        });
        // Ferme le canal opérationnel Meta de chaque Shop concernée.
        for (const c of conns) {
          await tx.whatsAppChannel.updateMany({
            where: {
              organizationId: c.organizationId,
              shopId: c.shopId,
              provider: 'META_CLOUD',
              status: { in: [...ACTIVE_STATUSES] },
            },
            data: { status: 'DISCONNECTED', disconnectedAt: now },
          });
        }
      }

      const revoked = await tx.metaWhatsAppCredential.updateMany({
        where: { id: { in: credIds }, status: { not: 'REVOKED' } },
        data: { status: 'REVOKED', revokedAt: now },
      });
      return { connectionsClosed: conns.length, credentialsRevoked: revoked.count };
    });
  }
}
