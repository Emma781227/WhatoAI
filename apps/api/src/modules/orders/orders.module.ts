import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { AuthModule } from '../auth/auth.module';
import { CartsModule } from '../carts/carts.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OrderConversionService } from './order-conversion.service';
import { OrderSequenceService } from './order-sequence.service';
import { OrderStockService } from './order-stock.service';
import { OrderTransitionService } from './order-transition.service';
import { ConversationOrdersController, OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [AuthModule, OrganizationsModule, CartsModule],
  controllers: [ConversationOrdersController, OrdersController],
  providers: [
    OrdersService,
    OrderConversionService,
    OrderTransitionService,
    OrderSequenceService,
    OrderStockService,
    TenantGuard,
    PermissionsGuard,
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
