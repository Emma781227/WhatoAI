import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ConversationMode,
  ConversationPriority,
  ConversationStatus,
  MembershipRole,
  MessageDirection,
  MessageSenderType,
  MessageStatus,
  MessageType,
} from '@whauto/database';

import type { ConversationPublic, MessagePublic } from '../conversations.mapper';

export class ContactSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiPropertyOptional({ nullable: true })
  displayName!: string | null;

  @ApiProperty()
  whatsappPhone!: string;

  @ApiProperty()
  normalizedPhone!: string;

  @ApiPropertyOptional({ nullable: true })
  profilePictureUrl!: string | null;
}

export class AssignedMembershipDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: MembershipRole })
  role!: MembershipRole;

  @ApiProperty()
  user!: { id: string; firstName: string; lastName: string };
}

export class ConversationTagDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  color!: string | null;
}

export class MessagePreviewDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: MessageDirection })
  direction!: MessageDirection;

  @ApiProperty({ enum: MessageType })
  type!: MessageType;

  @ApiProperty({ enum: MessageStatus })
  status!: MessageStatus;

  @ApiProperty({ enum: MessageSenderType })
  senderType!: MessageSenderType;

  @ApiPropertyOptional({ nullable: true })
  textContent!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class ConversationResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  shopId!: string;

  @ApiProperty()
  channelId!: string;

  @ApiProperty()
  contactId!: string;

  @ApiProperty({ enum: ConversationStatus })
  status!: ConversationStatus;

  @ApiProperty({ enum: ConversationMode })
  mode!: ConversationMode;

  @ApiProperty({ enum: ConversationPriority })
  priority!: ConversationPriority;

  @ApiPropertyOptional({ nullable: true })
  assignedMembershipId!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  lastMessageAt!: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastInboundMessageAt!: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastOutboundMessageAt!: Date | null;

  @ApiProperty()
  unreadCount!: number;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  customerServiceWindowExpiresAt!: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: ContactSummaryDto })
  contact!: ContactSummaryDto;

  @ApiPropertyOptional({ type: AssignedMembershipDto, nullable: true })
  assignedMembership!: AssignedMembershipDto | null;

  @ApiProperty({ type: [ConversationTagDto] })
  tags!: ConversationTagDto[];

  @ApiPropertyOptional({ type: MessagePreviewDto, nullable: true })
  lastMessage!: MessagePreviewDto | null;

  static fromConversation(conversation: ConversationPublic): ConversationResponseDto {
    const { tags, messages, ...rest } = conversation;
    return Object.assign(new ConversationResponseDto(), rest, {
      tags: tags.map((entry) => entry.tag),
      lastMessage: messages[0] ?? null,
    });
  }
}

export class MessageResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  shopId!: string;

  @ApiProperty()
  conversationId!: string;

  @ApiProperty()
  channelId!: string;

  @ApiProperty()
  contactId!: string;

  @ApiPropertyOptional({ nullable: true })
  clientMessageId!: string | null;

  @ApiProperty({ enum: MessageDirection })
  direction!: MessageDirection;

  @ApiProperty({ enum: MessageType })
  type!: MessageType;

  @ApiProperty({ enum: MessageStatus })
  status!: MessageStatus;

  @ApiProperty({ enum: MessageSenderType })
  senderType!: MessageSenderType;

  @ApiPropertyOptional({ nullable: true })
  senderUserId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  senderUser!: { id: string; firstName: string; lastName: string } | null;

  @ApiPropertyOptional({ nullable: true })
  textContent!: string | null;

  @ApiPropertyOptional({ nullable: true })
  mediaUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  mediaMimeType!: string | null;

  @ApiPropertyOptional({ nullable: true })
  mediaFileName!: string | null;

  @ApiPropertyOptional({ nullable: true })
  quotedMessageId!: string | null;

  @ApiPropertyOptional({ nullable: true })
  errorCode!: string | null;

  @ApiPropertyOptional({ nullable: true })
  errorMessage!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  sentAt!: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  deliveredAt!: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  readAt!: Date | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  failedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  static fromMessage(message: MessagePublic): MessageResponseDto {
    return Object.assign(new MessageResponseDto(), message);
  }
}

export class CursorPaginatedConversationsDto {
  @ApiProperty({ type: [ConversationResponseDto] })
  items!: ConversationResponseDto[];

  @ApiPropertyOptional({ nullable: true, description: 'null = fin de liste.' })
  nextCursor!: string | null;
}

export class CursorPaginatedMessagesDto {
  @ApiProperty({ type: [MessageResponseDto] })
  items!: MessageResponseDto[];

  @ApiPropertyOptional({ nullable: true, description: 'null = fin de liste.' })
  nextCursor!: string | null;
}
