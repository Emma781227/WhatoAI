import { Module } from '@nestjs/common';

import { WhatsAppInboundModule } from '../whatsapp-inbound/whatsapp-inbound.module';
import { MetaAppCallbacksController } from './meta-app-callbacks.controller';
import { MetaAppCallbacksService } from './meta-app-callbacks.service';
import { MetaWebhookController } from './meta-webhook.controller';
import { MetaWebhookService } from './meta-webhook.service';

/**
 * Webhooks fournisseurs PUBLICS (aucun guard tenant). Réutilise la durable
 * inbox via WhatsAppInboundModule — le webhook Meta ne fait que valider (HMAC),
 * parser et persister ; le worker traite le reste. Inclut aussi les callbacks
 * d'App Review (deauthorize / data-deletion), vérifiés par `signed_request`.
 */
@Module({
  imports: [WhatsAppInboundModule],
  controllers: [MetaWebhookController, MetaAppCallbacksController],
  providers: [MetaWebhookService, MetaAppCallbacksService],
})
export class WebhooksModule {}
