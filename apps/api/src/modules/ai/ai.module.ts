import { Module } from '@nestjs/common';

import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { WhatsAppQueuesModule } from '../../queues/whatsapp-queues.module';
import { AuthModule } from '../auth/auth.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AiAutoReplyService } from './ai-auto-reply.service';
import { AiConfigurationService } from './ai-configuration.service';
import { AiController } from './ai.controller';
import { AiRunsService } from './ai-runs.service';
import { AiSuggestionsService } from './ai-suggestions.service';

/**
 * Module IA côté API (sous-phase B). L'acceptation d'une suggestion réutilise
 * MessagesService (flux d'envoi humain existant) via ConversationsModule —
 * jamais d'appel direct au provider. AUTO_REPLY non activable fonctionnellement.
 */
@Module({
  imports: [AuthModule, OrganizationsModule, ConversationsModule, WhatsAppQueuesModule],
  controllers: [AiController],
  providers: [
    AiConfigurationService,
    AiAutoReplyService,
    AiSuggestionsService,
    AiRunsService,
    TenantGuard,
    PermissionsGuard,
  ],
})
export class AiModule {}
