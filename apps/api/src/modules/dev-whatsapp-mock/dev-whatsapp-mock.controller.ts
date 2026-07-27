import { randomUUID } from 'node:crypto';

import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { generateMockWamid } from '@whauto/whatsapp';
import type { MockInboundBody } from '@whauto/whatsapp';

import { InboundIngestionService } from '../whatsapp-inbound/inbound-ingestion.service';
import { MockInboundDto, MockStatusDto } from './dto/mock-inbound.dto';

/**
 * Simulateur du point de vue Meta — dev/test UNIQUEMENT. Le module n'est
 * enregistré que si ENABLE_MOCK_WHATSAPP_ENDPOINTS=true (jamais possible en
 * production, forcé par Zod) : ces routes n'existent alors physiquement pas.
 *
 * Comme un webhook réel : pas d'auth tenant — le canal désigné est l'autorité,
 * et l'événement emprunte la pipeline complète (validation provider →
 * normalisation → durable inbox → BullMQ → worker).
 */
@ApiTags('dev-whatsapp-mock')
@Controller('dev/whatsapp/mock')
export class DevWhatsAppMockController {
  constructor(private readonly ingestion: InboundIngestionService) {}

  @Post('inbound')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: '[DEV] Simuler un message client entrant sur un canal MOCK' })
  async inbound(@Body() dto: MockInboundDto): Promise<{ inboundEventIds: string[] }> {
    const externalMessageId = dto.externalMessageId ?? generateMockWamid();
    const body: MockInboundBody = {
      mock: true,
      kind: 'message',
      // Un même externalMessageId doit produire le même externalEventId pour
      // que la relivraison soit détectée par la durable inbox.
      externalEventId: `msg:${externalMessageId}`,
      externalMessageId,
      from: dto.phone,
      displayName: dto.displayName,
      text: dto.text,
      timestamp: new Date().toISOString(),
    };
    return this.ingestion.ingest(dto.channelId, { body });
  }

  @Post('status')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: '[DEV] Simuler un statut DELIVERED/READ/FAILED pour un message sortant' })
  async status(@Body() dto: MockStatusDto): Promise<{ inboundEventIds: string[] }> {
    const body: MockInboundBody = {
      mock: true,
      kind: 'status',
      externalEventId: `status:${dto.externalMessageId}:${dto.status}:${randomUUID()}`,
      externalMessageId: dto.externalMessageId,
      status: dto.status,
      timestamp: new Date().toISOString(),
      errorCode: dto.errorCode,
      errorMessage: dto.errorCode !== undefined ? 'Simulated provider failure.' : undefined,
    };
    return this.ingestion.ingest(dto.channelId, { body });
  }
}
