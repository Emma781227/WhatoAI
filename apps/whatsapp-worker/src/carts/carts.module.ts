import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { CartExpirationService } from './cart-expiration.service';

@Module({
  // WhatsAppModule : fournit RealtimeEmitterService (redis-emitter partagé).
  imports: [PrismaModule, WhatsAppModule],
  providers: [CartExpirationService],
  exports: [CartExpirationService],
})
export class CartsWorkerModule {}
