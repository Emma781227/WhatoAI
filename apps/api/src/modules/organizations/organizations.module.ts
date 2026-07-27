import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import {
  MyInvitationsController,
  OrganizationInvitationsController,
} from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { MembershipsController } from './memberships.controller';
import { MembershipsService } from './memberships.service';
import { OrganizationAuditService } from './organization-audit.service';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  // AuthModule fournit JwtAuthGuard/EmailVerifiedGuard/TokenService (et exporte JwtModule).
  imports: [AuthModule, EmailModule],
  controllers: [
    OrganizationsController,
    OrganizationInvitationsController,
    MyInvitationsController,
    MembershipsController,
  ],
  providers: [
    OrganizationsService,
    InvitationsService,
    MembershipsService,
    OrganizationAuditService,
    TenantGuard,
    PermissionsGuard,
  ],
  exports: [OrganizationAuditService],
})
export class OrganizationsModule {}
