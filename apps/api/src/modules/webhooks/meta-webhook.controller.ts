import { Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { MetaWebhookService } from './meta-webhook.service';

/**
 * Webhook Meta WhatsApp Cloud API — PUBLIC (aucun JwtAuthGuard/TenantGuard).
 * Le contrôleur reste ultra-fin : il extrait le corps brut + la signature et
 * délègue. Exclu de Swagger (endpoint fournisseur, aucun secret documenté).
 */
@ApiExcludeController()
@Controller('webhooks/whatsapp/meta')
export class MetaWebhookController {
  constructor(private readonly webhookService: MetaWebhookService) {}

  /** Vérification d'abonnement Meta (challenge). Aucune auth, aucun log du token. */
  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): string {
    return this.webhookService.verifySubscription(mode, token, challenge);
  }

  /**
   * Événements Meta. ACK 200 rapide : la durable inbox absorbe le traitement,
   * BullMQ fait le reste. Le corps brut sert au HMAC (jamais le JSON
   * re-sérialisé). Signature invalide → 401 (levée par le service).
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async receive(@Req() request: RawBodyRequest<Request>): Promise<{ received: true }> {
    await this.webhookService.handleEvent({
      rawBody: request.rawBody?.toString('utf8'),
      signature: request.headers['x-hub-signature-256'] as string | undefined,
      parsedBody: request.body,
    });
    return { received: true };
  }
}
