import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import { PaymentWebhookSignatureError } from '@whauto/payments';

import { PrismaService } from '../../prisma/prisma.service';
import { PaymentProviderFactory } from '../../wallet/payment-provider.factory';
import { TopUpService } from '../../wallet/topup.service';

/**
 * Orchestration des webhooks de PAIEMENT (Genius Pay). Le contrôleur reste
 * ultra-fin. Le provider est l'AUTORITÉ CRYPTOGRAPHIQUE (signature vérifiée une
 * seule fois ici, sur `timestamp + "." + corps brut`). Aucun secret n'est loggé
 * ni persisté. Ce groupe (G3) VALIDE + PERSISTE dans la durable inbox de manière
 * idempotente ; il ne CRÉDITE PAS le Wallet (résolution TopUp + contrôle
 * montant/devise + creditTopUp = groupe suivant). Le `returnUrl` navigateur n'est
 * jamais une preuve — seul ce webhook signé (ou une vérification serveur) confirme.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerFactory: PaymentProviderFactory,
    private readonly topUps: TopUpService,
  ) {}

  async handleGeniusPay(input: {
    rawBody: string | undefined;
    signature: string | undefined;
    timestamp: string | undefined;
    eventHeader: string | undefined;
  }): Promise<void> {
    const provider = this.providerFactory.get();
    // Genius Pay non actif (ex. PAYMENT_PROVIDER=MOCK) : on ACK et on ignore, pour
    // ne pas provoquer de relances côté agrégateur. Aucune vérification possible.
    if (provider.getProviderName() !== 'GENIUS_PAY') {
      this.logger.warn('Webhook Genius Pay reçu mais provider inactif — ignoré (ACK).');
      return;
    }

    // AUTORITÉ CRYPTOGRAPHIQUE : HMAC-SHA256 de `timestamp + "." + corps brut`.
    const valid = provider.verifyWebhookSignature({
      rawBody: input.rawBody,
      signature: input.signature,
      timestamp: input.timestamp,
    });
    if (!valid || !input.rawBody) {
      // Signature invalide/absente → 401. Jamais de crédit sur un webhook non prouvé.
      throw new PaymentWebhookSignatureError();
    }

    const event = provider.parseWebhook(input.rawBody);
    if (!event.externalEventId) {
      // Aucun identifiant d'événement : rien à dédupliquer, ACK sans écriture.
      this.logger.warn('Webhook Genius Pay signé sans identifiant d’événement — ignoré (ACK).');
      return;
    }

    // Seuls les événements `payment.*` sont actionnables pour un TopUp ; les
    // autres (webhook.test, cashout.*) sont conservés en IGNORED pour diagnostic.
    const actionable = event.eventType.startsWith('payment.');

    // Persist AVANT tout traitement (durable inbox, dédup). Trois livraisons
    // identiques = une seule ligne (P2002 → déjà reçu, no-op idempotent).
    let eventRowId: string;
    try {
      const created = await this.prisma.paymentWebhookEvent.create({
        data: {
          provider: 'GENIUS_PAY',
          externalEventId: event.externalEventId,
          providerPaymentId: event.providerPaymentId || null,
          eventType: event.eventType,
          // Événement NORMALISÉ filtré — jamais la signature, le secret ni les
          // en-têtes bruts.
          normalizedPayload: {
            eventType: event.eventType,
            providerPaymentId: event.providerPaymentId,
            status: event.status,
            reference: event.reference,
            amount: event.amount,
            currency: event.currency,
          },
          status: actionable ? 'RECEIVED' : 'IGNORED',
        },
        select: { id: true },
      });
      eventRowId = created.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.debug(`Webhook Genius Pay déjà reçu (${event.externalEventId}) — dédupliqué.`);
        return;
      }
      throw error;
    }

    if (!actionable) {
      return; // webhook.test / cashout.* : conservé IGNORED, rien à traiter.
    }

    // Traitement best-effort : le CRÉDIT passe par `creditTopUp` existant (aucune
    // logique comptable ici). Un échec laisse l'événement RECEIVED → la
    // reconciliation le rejouera (idempotent). L'ACK reste 200 dans tous les cas.
    try {
      const result = await this.topUps.applyPaymentOutcome({
        providerPaymentId: event.providerPaymentId,
        status: event.status,
        amount: event.amount,
        currency: event.currency,
        reference: event.reference,
      });
      await this.prisma.paymentWebhookEvent.update({
        where: { id: eventRowId },
        data: {
          status: 'PROCESSED',
          processedAt: new Date(),
          lastErrorCode: result.matched ? result.reason : 'TOPUP_NOT_FOUND',
        },
        select: { id: true },
      });
    } catch (error) {
      await this.prisma.paymentWebhookEvent
        .update({
          where: { id: eventRowId },
          data: { attemptCount: { increment: 1 }, lastErrorCode: 'PROCESSING_ERROR' },
          select: { id: true },
        })
        .catch(() => undefined);
      this.logger.warn(
        `Traitement webhook Genius Pay ${event.externalEventId} échoué (rejeu par reconciliation) : ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
