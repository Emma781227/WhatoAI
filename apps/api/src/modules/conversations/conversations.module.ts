import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';

@Module({
  imports: [AuthModule, OrganizationsModule, OutboxModule],
  controllers: [ConversationsController],
  providers: [ConversationsService, MessagesService, TenantGuard, PermissionsGuard],
  exports: [ConversationsService, MessagesService],
})
export class ConversationsModule {}
