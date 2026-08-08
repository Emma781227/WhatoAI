import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import { PERMISSIONS } from '../../common/tenant/permissions';
import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { RequirePermissions } from '../../common/tenant/require-permissions.decorator';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WhatsAppChannelResponseDto } from './dto/channel-responses.dto';
import { CreateMockChannelDto } from './dto/create-mock-channel.dto';
import {
  ConnectMetaChannelDto,
  EmbeddedSignupDto,
  MetaChannelHealthResponseDto,
  SendTestMessageDto,
  SendTestMessageResponseDto,
} from './dto/meta-channel.dto';
import { WhatsAppChannelsService } from './whatsapp-channels.service';

function actionContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

@ApiTags('whatsapp-channels')
@ApiBearerAuth()
@Controller('organizations/:organizationId/shops/:shopId/whatsapp-channel')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class WhatsAppChannelsController {
  constructor(private readonly channelsService: WhatsAppChannelsService) {}

  @Post('mock')
  @UseGuards(EmailVerifiedGuard)
  @RequirePermissions(PERMISSIONS.WHATSAPP_CHANNELS_MANAGE)
  @ApiOperation({
    summary:
      'Connecter un canal WhatsApp MOCK (aucun secret Meta) — un seul canal actif par Shop',
  })
  @ApiCreatedResponse({ type: WhatsAppChannelResponseDto })
  async connectMock(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Body() dto: CreateMockChannelDto,
    @Req() req: Request,
  ): Promise<WhatsAppChannelResponseDto> {
    return WhatsAppChannelResponseDto.fromChannel(
      await this.channelsService.connectMock(tenant, shopId, dto, actionContext(req)),
    );
  }

  @Post('meta/connect')
  @UseGuards(EmailVerifiedGuard)
  @RequirePermissions(PERMISSIONS.WHATSAPP_CHANNELS_MANAGE)
  @ApiOperation({
    summary:
      'Connecter le canal Meta PILOTE (config depuis l’environnement, vérifiée via Graph sans envoi)',
  })
  @ApiCreatedResponse({ type: WhatsAppChannelResponseDto })
  async connectMeta(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Body() dto: ConnectMetaChannelDto,
    @Req() req: Request,
  ): Promise<WhatsAppChannelResponseDto> {
    return WhatsAppChannelResponseDto.fromChannel(
      await this.channelsService.connectMeta(tenant, shopId, dto, actionContext(req)),
    );
  }

  @Post('meta/embedded-signup')
  @UseGuards(EmailVerifiedGuard)
  @RequirePermissions(PERMISSIONS.WHATSAPP_CHANNELS_MANAGE)
  @ApiOperation({
    summary:
      'Connecter le WhatsApp du commerçant via Embedded Signup (échange OAuth + provisioning) — multi-tenant',
  })
  @ApiCreatedResponse({ type: WhatsAppChannelResponseDto })
  async embeddedSignup(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Body() dto: EmbeddedSignupDto,
    @Req() req: Request,
  ): Promise<WhatsAppChannelResponseDto> {
    return WhatsAppChannelResponseDto.fromChannel(
      await this.channelsService.onboard(tenant, shopId, dto, actionContext(req)),
    );
  }

  @Get('meta/health')
  @RequirePermissions(PERMISSIONS.WHATSAPP_CHANNELS_MANAGE)
  @ApiOperation({ summary: 'Santé de la config Meta (GET Graph — AUCUN envoi de message)' })
  @ApiOkResponse({ type: MetaChannelHealthResponseDto })
  async metaHealth(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Req() req: Request,
  ): Promise<MetaChannelHealthResponseDto> {
    return this.channelsService.metaHealth(tenant, shopId, actionContext(req));
  }

  @Post('meta/send-test')
  @RequirePermissions(PERMISSIONS.WHATSAPP_CHANNELS_MANAGE)
  @ApiOperation({
    summary: 'Envoi de test RÉEL (diagnostic) — destinataire explicite + confirm=true requis',
  })
  @ApiCreatedResponse({ type: SendTestMessageResponseDto })
  async sendTestMessage(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Body() dto: SendTestMessageDto,
    @Req() req: Request,
  ): Promise<SendTestMessageResponseDto> {
    const result = await this.channelsService.sendTestMessage(
      tenant,
      shopId,
      { to: dto.to, text: dto.text },
      actionContext(req),
    );
    return { sent: true, providerMessageId: result.providerMessageId };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.WHATSAPP_CHANNELS_READ)
  @ApiOperation({
    summary: 'Canal courant de la Shop (actif, ou dernier canal en erreur) — 404 sinon',
  })
  @ApiOkResponse({ type: WhatsAppChannelResponseDto })
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
  ): Promise<WhatsAppChannelResponseDto> {
    return WhatsAppChannelResponseDto.fromChannel(
      await this.channelsService.getForShop(tenant, shopId),
    );
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.WHATSAPP_CHANNELS_MANAGE)
  @ApiOperation({ summary: 'Déconnecter le canal courant (terminal, libère le slot de la Shop)' })
  @ApiOkResponse({ type: WhatsAppChannelResponseDto })
  async disconnect(
    @CurrentTenant() tenant: TenantContext,
    @Param('shopId') shopId: string,
    @Req() req: Request,
  ): Promise<WhatsAppChannelResponseDto> {
    return WhatsAppChannelResponseDto.fromChannel(
      await this.channelsService.disconnect(tenant, shopId, actionContext(req)),
    );
  }
}
