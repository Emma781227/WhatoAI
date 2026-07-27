import { Module } from '@nestjs/common';

import { WhatsAppInboundModule } from '../whatsapp-inbound/whatsapp-inbound.module';
import { DevWhatsAppMockController } from './dev-whatsapp-mock.controller';

/**
 * Enregistré CONDITIONNELLEMENT dans AppModule, uniquement quand
 * ENABLE_MOCK_WHATSAPP_ENDPOINTS=true (le schéma Zod interdit true en
 * production). Quand il est absent, les routes /api/dev/whatsapp/mock/*
 * n'existent pas — 404 naturel, sans garde à contourner.
 */
@Module({
  imports: [WhatsAppInboundModule],
  controllers: [DevWhatsAppMockController],
})
export class DevWhatsAppMockModule {}
