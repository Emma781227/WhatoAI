import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OpeningHoursService } from './opening-hours.service';
import { ShopsController } from './shops.controller';
import { ShopsService } from './shops.service';

@Module({
  // AuthModule : JwtAuthGuard/EmailVerifiedGuard. OrganizationsModule : OrganizationAuditService.
  imports: [AuthModule, OrganizationsModule],
  controllers: [ShopsController],
  providers: [ShopsService, OpeningHoursService, TenantGuard, PermissionsGuard],
})
export class ShopsModule {}
