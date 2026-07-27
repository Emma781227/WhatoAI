import { Module } from '@nestjs/common';

import { WhatsAppQueuesModule } from '../../queues/whatsapp-queues.module';
import { OutboxPublisherService } from './outbox-publisher.service';

@Module({
  imports: [WhatsAppQueuesModule],
  providers: [OutboxPublisherService],
  exports: [OutboxPublisherService],
})
export class OutboxModule {}
