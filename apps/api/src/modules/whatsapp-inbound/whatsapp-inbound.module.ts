import { Module } from '@nestjs/common';

import { WhatsAppQueuesModule } from '../../queues/whatsapp-queues.module';
import { InboundIngestionService } from './inbound-ingestion.service';
import { WhatsAppProviderFactory } from './whatsapp-provider.factory';

/**
 * Pipeline d'ingestion des événements fournisseur (durable inbox). Aucun
 * controller ici : les entrées sont les endpoints dev mock (module dédié,
 * conditionnel) puis le webhook Meta réel (phase ultérieure).
 */
@Module({
  imports: [WhatsAppQueuesModule],
  providers: [InboundIngestionService, WhatsAppProviderFactory],
  exports: [InboundIngestionService, WhatsAppProviderFactory],
})
export class WhatsAppInboundModule {}
