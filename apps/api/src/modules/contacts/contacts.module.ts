import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { AuthModule } from '../auth/auth.module';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

@Module({
  imports: [AuthModule],
  controllers: [ContactsController],
  providers: [ContactsService, TenantGuard, PermissionsGuard],
  exports: [ContactsService],
})
export class ContactsModule {}
