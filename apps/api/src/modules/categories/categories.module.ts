import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

@Module({
  imports: [AuthModule, OrganizationsModule],
  controllers: [CategoriesController],
  providers: [CategoriesService, TenantGuard, PermissionsGuard],
  exports: [CategoriesService],
})
export class CategoriesModule {}
