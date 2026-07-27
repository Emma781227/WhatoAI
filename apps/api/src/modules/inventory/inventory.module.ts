import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [AuthModule, OrganizationsModule],
  controllers: [InventoryController],
  providers: [InventoryService, TenantGuard, PermissionsGuard],
  exports: [InventoryService],
})
export class InventoryModule {}
