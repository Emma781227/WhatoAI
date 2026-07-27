import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { WhatsAppInboundModule } from '../whatsapp-inbound/whatsapp-inbound.module';
import { WhatsAppChannelsController } from './whatsapp-channels.controller';
import { WhatsAppChannelsService } from './whatsapp-channels.service';

@Module({
  // AuthModule : JwtAuthGuard/EmailVerifiedGuard. OrganizationsModule :
  // OrganizationAuditService. WhatsAppInboundModule : WhatsAppProviderFactory
  // (provider Meta pour health/test/connect).
  imports: [AuthModule, OrganizationsModule, WhatsAppInboundModule],
  controllers: [WhatsAppChannelsController],
  providers: [WhatsAppChannelsService, TenantGuard, PermissionsGuard],
  exports: [WhatsAppChannelsService],
})
export class WhatsAppChannelsModule {}
