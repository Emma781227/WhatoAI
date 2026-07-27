import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentTenant } from '../../common/tenant/current-tenant.decorator';
import { PERMISSIONS } from '../../common/tenant/permissions';
import { PermissionsGuard } from '../../common/tenant/permissions.guard';
import { RequirePermissions } from '../../common/tenant/require-permissions.decorator';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  AddNoteDto,
  AddTagDto,
  AssignConversationDto,
  SendMessageDto,
  UpdateConversationStatusDto,
} from './dto/conversation-actions.dto';
import {
  ListConversationsQueryDto,
  ListMessagesQueryDto,
} from './dto/conversation-queries.dto';
import {
  ConversationResponseDto,
  CursorPaginatedConversationsDto,
  CursorPaginatedMessagesDto,
  MessageResponseDto,
} from './dto/conversation-responses.dto';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';

function actionContext(req: Request) {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

@ApiTags('conversations')
@ApiBearerAuth()
@Controller('organizations/:organizationId/conversations')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly messagesService: MessagesService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_READ)
  @ApiOperation({
    summary:
      'Conversations (cursor keyset, tri lastMessageAt desc, filtres shop/status/assignation/unread/tags/priorité/recherche)',
  })
  @ApiOkResponse({ type: CursorPaginatedConversationsDto })
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: ListConversationsQueryDto,
  ): Promise<CursorPaginatedConversationsDto> {
    const { items, nextCursor } = await this.conversationsService.list(tenant, query);
    return {
      items: items.map((conversation) => ConversationResponseDto.fromConversation(conversation)),
      nextCursor,
    };
  }

  @Get(':conversationId')
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_READ)
  @ApiOperation({ summary: 'Détail d’une conversation (contact, tags, assignation)' })
  @ApiOkResponse({ type: ConversationResponseDto })
  async get(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
  ): Promise<ConversationResponseDto> {
    return ConversationResponseDto.fromConversation(
      await this.conversationsService.getForTenant(tenant, conversationId),
    );
  }

  @Get(':conversationId/messages')
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_READ)
  @ApiOperation({ summary: 'Messages du fil (cursor keyset, plus récents d’abord)' })
  @ApiOkResponse({ type: CursorPaginatedMessagesDto })
  async listMessages(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Query() query: ListMessagesQueryDto,
  ): Promise<CursorPaginatedMessagesDto> {
    const { items, nextCursor } = await this.messagesService.list(tenant, conversationId, query);
    return { items: items.map((message) => MessageResponseDto.fromMessage(message)), nextCursor };
  }

  @Post(':conversationId/messages')
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_REPLY)
  @ApiOperation({
    summary:
      'Répondre (texte) — transactional outbox, idempotent par clientMessageId, fenêtre 24 h requise',
  })
  @ApiCreatedResponse({ type: MessageResponseDto })
  async sendMessage(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: SendMessageDto,
  ): Promise<MessageResponseDto> {
    return MessageResponseDto.fromMessage(
      await this.messagesService.send(tenant, conversationId, dto),
    );
  }

  @Post(':conversationId/messages/:messageId/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_REPLY)
  @ApiOperation({ summary: 'Retenter un message FAILED (seule transition FAILED → PENDING)' })
  @ApiOkResponse({ type: MessageResponseDto })
  async retryMessage(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<MessageResponseDto> {
    return MessageResponseDto.fromMessage(
      await this.messagesService.retry(tenant, conversationId, messageId),
    );
  }

  @Post(':conversationId/notes')
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_ADD_NOTE)
  @ApiOperation({ summary: 'Note interne (jamais envoyée au provider, visible équipe uniquement)' })
  @ApiCreatedResponse({ type: MessageResponseDto })
  async addNote(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: AddNoteDto,
  ): Promise<MessageResponseDto> {
    return MessageResponseDto.fromMessage(
      await this.messagesService.addNote(tenant, conversationId, dto.text),
    );
  }

  @Post(':conversationId/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_ASSIGN)
  @ApiOperation({ summary: 'Assigner à un Membership ACTIVE de l’organisation' })
  @ApiOkResponse({ type: ConversationResponseDto })
  async assign(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: AssignConversationDto,
    @Req() req: Request,
  ): Promise<ConversationResponseDto> {
    return ConversationResponseDto.fromConversation(
      await this.conversationsService.assign(
        tenant,
        conversationId,
        dto.membershipId,
        actionContext(req),
      ),
    );
  }

  @Post(':conversationId/unassign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_ASSIGN)
  @ApiOperation({ summary: 'Retirer l’assignation (idempotent)' })
  @ApiOkResponse({ type: ConversationResponseDto })
  async unassign(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Req() req: Request,
  ): Promise<ConversationResponseDto> {
    return ConversationResponseDto.fromConversation(
      await this.conversationsService.unassign(tenant, conversationId, actionContext(req)),
    );
  }

  @Patch(':conversationId/status')
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_UPDATE_STATUS)
  @ApiOperation({
    summary:
      'Changer le statut (OPEN⇄PENDING→RESOLVED→CLOSED ; RESOLVED rouvrable si aucune conversation active concurrente ; CLOSED terminal)',
  })
  @ApiOkResponse({ type: ConversationResponseDto })
  async updateStatus(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: UpdateConversationStatusDto,
    @Req() req: Request,
  ): Promise<ConversationResponseDto> {
    return ConversationResponseDto.fromConversation(
      await this.conversationsService.updateStatus(
        tenant,
        conversationId,
        dto.status,
        actionContext(req),
      ),
    );
  }

  @Post(':conversationId/read')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_READ)
  @ApiOperation({ summary: 'Marquer comme lue (unreadCount = 0, idempotent)' })
  @ApiOkResponse({ type: ConversationResponseDto })
  async markRead(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
  ): Promise<ConversationResponseDto> {
    return ConversationResponseDto.fromConversation(
      await this.conversationsService.markRead(tenant, conversationId),
    );
  }

  @Post(':conversationId/tags')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_MANAGE_TAGS)
  @ApiOperation({ summary: 'Ajouter un tag (créé dans l’organisation si nouveau, idempotent)' })
  @ApiOkResponse({ type: ConversationResponseDto })
  async addTag(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: AddTagDto,
    @Req() req: Request,
  ): Promise<ConversationResponseDto> {
    return ConversationResponseDto.fromConversation(
      await this.conversationsService.addTag(tenant, conversationId, dto.name, actionContext(req)),
    );
  }

  @Delete(':conversationId/tags/:tagId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.CONVERSATIONS_MANAGE_TAGS)
  @ApiOperation({ summary: 'Retirer un tag de la conversation' })
  @ApiOkResponse({ type: ConversationResponseDto })
  async removeTag(
    @CurrentTenant() tenant: TenantContext,
    @Param('conversationId') conversationId: string,
    @Param('tagId') tagId: string,
    @Req() req: Request,
  ): Promise<ConversationResponseDto> {
    return ConversationResponseDto.fromConversation(
      await this.conversationsService.removeTag(tenant, conversationId, tagId, actionContext(req)),
    );
  }
}
