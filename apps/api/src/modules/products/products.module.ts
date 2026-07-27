import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { VariantLookupController } from './variant-lookup.controller';
import { VariantsService } from './variants.service';

@Module({
  imports: [AuthModule, OrganizationsModule],
  controllers: [ProductsController, VariantLookupController],
  providers: [ProductsService, VariantsService, TenantGuard, PermissionsGuard],
  exports: [ProductsService, VariantsService],
})
export class ProductsModule {}
