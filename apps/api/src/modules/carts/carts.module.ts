import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { CartsController } from './carts.controller';
import { CartsService } from './carts.service';
import { CheckoutService } from './checkout.service';
import { ReservationService } from './reservation.service';

@Module({
  imports: [AuthModule, OrganizationsModule],
  controllers: [CartsController],
  providers: [CartsService, CheckoutService, ReservationService, TenantGuard, PermissionsGuard],
  exports: [CartsService, CheckoutService, ReservationService],
})
export class CartsModule {}
