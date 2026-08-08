import { timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaWebhookSignatureError, MetaWebhookVerificationError } from '@whauto/shared';

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

    // AUTORITÉ CRYPTOGRAPHIQUE : HMAC-SHA256 du corps brut. Le secret d'App
    // (META_APP_SECRET) est commun à TOUS les tenants — un seul webhook signé
    // porte les événements de plusieurs commerçants.
    const valid = provider.validateInboundEvent({
      body: input.parsedBody,
      rawBody: input.rawBody,
      signature: input.signature,
    });
    if (!valid) {
      throw new MetaWebhookSignatureError();
    }

    // MULTI-TENANT : grouper par phone_number_id — chaque groupe est routé vers
    // SON canal (commerçant), jamais fusionné dans un seul.
    const groups = provider.parseInboundEventsByPhoneNumber({ body: input.parsedBody });
    if (groups.length === 0) {
      return; // Notification sans événement actionnable (ex. statut 'sent').
    }

    // Résolution des canaux actifs en UNE requête, puis routage par numéro.
    const channels = await this.prisma.whatsAppChannel.findMany({
      where: {
        provider: 'META_CLOUD',
        phoneNumberId: { in: groups.map((g) => g.phoneNumberId) },
        status: { in: ['CONNECTING', 'CONNECTED', 'SUSPENDED'] },
      },
      select: { id: true, organizationId: true, phoneNumberId: true },
      orderBy: { createdAt: 'asc' },
    });
    // Un phone_number_id ne devrait porter qu'un canal actif ; en cas d'ambiguïté
    // on prend le plus ancien (déterministe) — le premier rencontré est conservé.
    const channelByPhone = new Map<string, { id: string; organizationId: string }>();
    for (const channel of channels) {
      if (channel.phoneNumberId && !channelByPhone.has(channel.phoneNumberId)) {
        channelByPhone.set(channel.phoneNumberId, {
          id: channel.id,
          organizationId: channel.organizationId,
        });
      }
    }

    for (const group of groups) {
      const channel = channelByPhone.get(group.phoneNumberId);
      if (!channel) {
        // Signature valide mais phone_number_id inconnu : ACK, log technique
        // filtré, AUCUNE écriture métier (validé — ajustement 5). Les autres
        // groupes du même webhook restent traités.
        this.logger.warn(
          'Webhook Meta signé pour un phone_number_id non rattaché à un canal actif — groupe ignoré (ACK).',
        );
        continue;
      }

      await this.ingestion.persistAndPublish(channel, group.events);

      // Diagnostic UI — best-effort, ne bloque jamais l'ACK.
      await this.prisma.whatsAppChannel
        .update({ where: { id: channel.id }, data: { lastWebhookAt: new Date() } })
        .catch(() => undefined);
    }
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
