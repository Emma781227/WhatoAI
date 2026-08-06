import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';

import { PaymentWebhookService } from './payment-webhook.service';

/**
 * Webhook Genius Pay — PUBLIC (aucun JwtAuthGuard/TenantGuard, posture Meta).
 * Contrôleur ultra-fin : extrait le corps BRUT + les en-têtes de signature et
 * délègue. Exclu de Swagger (endpoint agrégateur, aucun secret documenté). ACK
 * 200 rapide ; une signature invalide lève 401 (le service).
 */
@ApiExcludeController()
@Controller('webhooks/payments')
export class GeniusPayWebhookController {
  constructor(private readonly webhookService: PaymentWebhookService) {}

  @Post('genius-pay')
  @HttpCode(HttpStatus.OK)
  async receive(@Req() request: RawBodyRequest<Request>): Promise<{ received: true }> {
    await this.webhookService.handleGeniusPay({
      rawBody: request.rawBody?.toString('utf8'),
      signature: request.headers['x-webhook-signature'] as string | undefined,
      timestamp: request.headers['x-webhook-timestamp'] as string | undefined,
      eventHeader: request.headers['x-webhook-event'] as string | undefined,
    });
    return { received: true };
  }
}
