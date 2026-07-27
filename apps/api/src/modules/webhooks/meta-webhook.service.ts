import { timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaWebhookSignatureError, MetaWebhookVerificationError } from '@whauto/shared';
import type { NormalizedInboundEvent } from '@whauto/whatsapp';

import { PrismaService } from '../../prisma/prisma.service';
import { InboundIngestionService } from '../whatsapp-inbound/inbound-ingestion.service';
import { WhatsAppProviderFactory } from '../whatsapp-inbound/whatsapp-provider.factory';

/**
 * Orchestration du webhook Meta — le contrôleur reste ultra-fin. Le provider
 * Meta est l'AUTORITÉ CRYPTOGRAPHIQUE (HMAC), appelé une seule fois ici. Aucun
 * secret n'est loggé. Aucune écriture métier avant l'ACK au-delà de la durable
 * inbox ; aucun appel IA (phase ultérieure).
 */
@Injectable()
export class MetaWebhookService {
  private readonly logger = new Logger(MetaWebhookService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly ingestion: InboundIngestionService,
    private readonly providerFactory: WhatsAppProviderFactory,
  ) {}

  /**
   * Vérification GET Meta : compare hub.verify_token au token d'environnement
   * (timing-safe) et renvoie le challenge exact. Le token n'est jamais loggé.
   */
  verifySubscription(mode: string | undefined, token: string | undefined, challenge: string | undefined): string {
    const expected = this.configService.get<string>('META_WEBHOOK_VERIFY_TOKEN');
    if (
      mode !== 'subscribe' ||
      !expected ||
      typeof token !== 'string' ||
      !this.safeEqual(token, expected) ||
      typeof challenge !== 'string'
    ) {
      throw new MetaWebhookVerificationError();
    }
    return challenge;
  }

  /**
   * Traitement d'un webhook POST. Signature vérifiée par le provider (autorité
   * unique). Un phone_number_id inconnu avec signature VALIDE est ACK sans
   * aucune écriture métier (validé — ajustement 5). Signature invalide/absente
   * → refus.
   */
  async handleEvent(input: {
    rawBody: string | undefined;
    signature: string | undefined;
    parsedBody: unknown;
  }): Promise<void> {
    // Meta non configuré : rien à traiter — on ACK pour ne pas provoquer de
    // relances Meta (impossible de vérifier quoi que ce soit sans App Secret).
    if (!this.providerFactory.isMetaConfigured()) {
      this.logger.warn('Webhook Meta reçu mais Meta non configuré — ignoré (ACK).');
      return;
    }

    const provider = this.providerFactory.getMetaProvider();

    // AUTORITÉ CRYPTOGRAPHIQUE : HMAC-SHA256 du corps brut.
    const valid = provider.validateInboundEvent({
      body: input.parsedBody,
      rawBody: input.rawBody,
      signature: input.signature,
    });
    if (!valid) {
      throw new MetaWebhookSignatureError();
    }

    const events: NormalizedInboundEvent[] = provider.parseInboundEvent({ body: input.parsedBody });
    if (events.length === 0) {
      return; // Notification sans événement actionnable (ex. statut 'sent').
    }

    const phoneNumberIds = provider.extractPhoneNumberIds(input.parsedBody);
    const channel =
      phoneNumberIds.length > 0
        ? await this.prisma.whatsAppChannel.findFirst({
            where: {
              provider: 'META_CLOUD',
              phoneNumberId: { in: phoneNumberIds },
              status: { in: ['CONNECTING', 'CONNECTED', 'SUSPENDED'] },
            },
            select: { id: true, organizationId: true },
          })
        : null;

    if (!channel) {
      // Signature valide mais phone_number_id inconnu : ACK, log technique
      // filtré, AUCUNE écriture métier (validé — ajustement 5).
      this.logger.warn(
        `Webhook Meta signé pour un phone_number_id non rattaché à un canal actif — ignoré (ACK).`,
      );
      return;
    }

    await this.ingestion.persistAndPublish(channel, events);

    // Diagnostic UI — best-effort, ne bloque jamais l'ACK.
    await this.prisma.whatsAppChannel
      .update({ where: { id: channel.id }, data: { lastWebhookAt: new Date() } })
      .catch(() => undefined);
  }

  private safeEqual(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) {
      return false;
    }
    return timingSafeEqual(bufferA, bufferB);
  }
}
