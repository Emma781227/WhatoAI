import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import type { ConversationPriority, ConversationStatus } from '@whauto/database';
import {
  AssigneeMembershipNotFoundError,
  ConflictError,
  ConversationClosedError,
  ConversationNotFoundError,
  InvalidConversationStatusTransitionError,
  MembershipNotAssignableError,
  SOCKET_EVENTS,
  TagNotFoundError,
} from '@whauto/shared';
import type { ConversationChangedEvent, ConversationUnreadUpdatedEvent } from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import { decodeCursor, encodeCursor } from './cursor.util';
import { CONVERSATION_PUBLIC_SELECT } from './conversations.mapper';
import type { ConversationPublic } from './conversations.mapper';

export interface ListConversationsQuery {
  cursor?: string;
  limit: number;
  shopId?: string;
  status?: ConversationStatus;
  priority?: ConversationPriority;
  assignedMembershipId?: string;
  unassigned?: boolean;
  unreadOnly?: boolean;
  search?: string;
  tagIds?: string[];
}

const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<ConversationStatus, readonly ConversationStatus[]>> = {
  OPEN: ['PENDING', 'RESOLVED', 'CLOSED'],
  PENDING: ['OPEN', 'RESOLVED', 'CLOSED'],
  // RESOLVED → OPEN = réouverture manuelle, protégée par l'index partiel
  // (une seule conversation active par contact+canal). CLOSED est terminal.
  RESOLVED: ['OPEN', 'CLOSED'],
  CLOSED: [],
};

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
    private readonly realtime: RealtimeService,
  ) {}

  private emitConversationUpdated(conversation: ConversationPublic): void {
    const payload: ConversationChangedEvent = {
      organizationId: conversation.organizationId,
      shopId: conversation.shopId,
      conversationId: conversation.id,
    };
    this.realtime.emitToOrganization(
      conversation.organizationId,
      SOCKET_EVENTS.CONVERSATION_UPDATED,
      payload,
    );
  }

  // --------------------------------------------------------------------- read

  async list(
    tenant: TenantContext,
    query: ListConversationsQuery,
  ): Promise<{ items: ConversationPublic[]; nextCursor: string | null }> {
    const where: Prisma.ConversationWhereInput = { organizationId: tenant.organizationId };

    if (query.shopId !== undefined) {
      where.shopId = query.shopId;
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.priority !== undefined) {
      where.priority = query.priority;
    }
    if (query.assignedMembershipId !== undefined) {
      where.assignedMembershipId = query.assignedMembershipId;
    } else if (query.unassigned === true) {
      where.assignedMembershipId = null;
    }
    if (query.unreadOnly === true) {
      where.unreadCount = { gt: 0 };
    }
    if (query.search !== undefined && query.search.trim() !== '') {
      const search = query.search.trim();
      // Recherche sur le contact, toujours dans le where tenant-scopé.
      where.contact = {
        OR: [
          { displayName: { contains: search, mode: 'insensitive' } },
          { normalizedPhone: { contains: search } },
          { whatsappPhone: { contains: search } },
        ],
      };
    }
    if (query.tagIds !== undefined && query.tagIds.length > 0) {
      // ET logique : la conversation porte chacun des tags demandés.
      where.AND = query.tagIds.map((tagId) => ({ tags: { some: { tagId } } }));
    }

    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      const pivot = new Date(cursor.t);
      where.OR = [
        { lastMessageAt: { lt: pivot } },
        { lastMessageAt: pivot, id: { lt: cursor.id } },
      ];
    }

    // take +1 : détecte s'il reste une page sans requête count.
    const rows = await this.prisma.conversation.findMany({
      where,
      select: CONVERSATION_PUBLIC_SELECT,
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    const nextCursor =
      rows.length > query.limit && last ? encodeCursor(last.lastMessageAt, last.id) : null;
    return { items, nextCursor };
  }

  async getForTenant(tenant: TenantContext, conversationId: string): Promise<ConversationPublic> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId: tenant.organizationId },
      select: CONVERSATION_PUBLIC_SELECT,
    });
    if (!conversation) {
      throw new ConversationNotFoundError();
    }
    return conversation;
  }

  // ------------------------------------------------------------------- assign

  async assign(
    tenant: TenantContext,
    conversationId: string,
    membershipId: string,
    context: AuditActionContext,
  ): Promise<ConversationPublic> {
    const conversation = await this.getForTenant(tenant, conversationId);
    if (conversation.status === 'CLOSED') {
      throw new ConversationClosedError();
    }

    // 404 pour un membership inexistant OU d'une autre org (anti-énumération).
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, organizationId: tenant.organizationId },
      select: { id: true, status: true, userId: true },
    });
    if (!membership) {
      throw new AssigneeMembershipNotFoundError();
    }
    if (membership.status !== 'ACTIVE') {
      throw new MembershipNotAssignableError();
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.conversation.updateMany({
        where: {
          id: conversationId,
          organizationId: tenant.organizationId,
          status: { not: 'CLOSED' },
        },
        data: { assignedMembershipId: membership.id },
      });
      if (updated.count !== 1) {
        throw new ConversationClosedError();
      }

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'CONVERSATION_ASSIGNED',
          actorUserId: tenant.userId,
          targetUserId: membership.userId,
          metadata: { conversationId, membershipId: membership.id },
          context,
        },
        tx,
      );

      return tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: CONVERSATION_PUBLIC_SELECT,
      });
    });
    this.emitConversationUpdated(result);
    return result;
  }

  async unassign(
    tenant: TenantContext,
    conversationId: string,
    context: AuditActionContext,
  ): Promise<ConversationPublic> {
    const conversation = await this.getForTenant(tenant, conversationId);
    if (conversation.assignedMembershipId === null) {
      return conversation; // Idempotent.
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.conversation.updateMany({
        where: {
          id: conversationId,
          organizationId: tenant.organizationId,
          assignedMembershipId: { not: null },
        },
        data: { assignedMembershipId: null },
      });

      if (updated.count === 1) {
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'CONVERSATION_UNASSIGNED',
            actorUserId: tenant.userId,
            metadata: { conversationId },
            context,
          },
          tx,
        );
      }

      return tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: CONVERSATION_PUBLIC_SELECT,
      });
    });
    this.emitConversationUpdated(result);
    return result;
  }

  // ------------------------------------------------------------------- status

  async updateStatus(
    tenant: TenantContext,
    conversationId: string,
    to: ConversationStatus,
    context: AuditActionContext,
  ): Promise<ConversationPublic> {
    const conversation = await this.getForTenant(tenant, conversationId);
    const from = conversation.status;
    if (!ALLOWED_STATUS_TRANSITIONS[from].includes(to)) {
      throw new InvalidConversationStatusTransitionError(from, to);
    }

    const data: Prisma.ConversationUpdateManyMutationInput = { status: to };
    if (to === 'RESOLVED') {
      data.resolvedAt = new Date();
    } else if (from === 'RESOLVED' && to === 'OPEN') {
      data.resolvedAt = null;
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.conversation.updateMany({
          where: { id: conversationId, organizationId: tenant.organizationId, status: from },
          data,
        });
        if (updated.count !== 1) {
          // Transition concurrente : l'état lu n'existe plus.
          throw new InvalidConversationStatusTransitionError(from, to);
        }

        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'CONVERSATION_STATUS_CHANGED',
            actorUserId: tenant.userId,
            metadata: { conversationId, from, to },
            context,
          },
          tx,
        );

        return tx.conversation.findUniqueOrThrow({
          where: { id: conversationId },
          select: CONVERSATION_PUBLIC_SELECT,
        });
      });
      this.emitConversationUpdated(result);
      return result;
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Réouverture refusée par l'index partiel : une autre conversation
        // active existe déjà pour ce contact+canal.
        throw new ConflictError(
          'Another active conversation already exists for this contact on this channel.',
        );
      }
      throw error;
    }
  }

  // --------------------------------------------------------------------- read marker

  async markRead(tenant: TenantContext, conversationId: string): Promise<ConversationPublic> {
    await this.getForTenant(tenant, conversationId);
    const updated = await this.prisma.conversation.updateMany({
      where: { id: conversationId, organizationId: tenant.organizationId, unreadCount: { gt: 0 } },
      data: { unreadCount: 0 },
    });
    const conversation = await this.getForTenant(tenant, conversationId);

    if (updated.count === 1) {
      const payload: ConversationUnreadUpdatedEvent = {
        organizationId: conversation.organizationId,
        shopId: conversation.shopId,
        conversationId: conversation.id,
        unreadCount: conversation.unreadCount,
      };
      this.realtime.emitToOrganization(
        conversation.organizationId,
        SOCKET_EVENTS.CONVERSATION_UNREAD_UPDATED,
        payload,
      );
    }
    return conversation;
  }

  // --------------------------------------------------------------------- tags

  /** Crée le Tag d'organisation s'il n'existe pas, puis l'attache (idempotent). */
  async addTag(
    tenant: TenantContext,
    conversationId: string,
    name: string,
    context: AuditActionContext,
  ): Promise<ConversationPublic> {
    await this.getForTenant(tenant, conversationId);
    const trimmed = name.trim();

    const result = await this.prisma.$transaction(async (tx) => {
      const tag = await tx.tag.upsert({
        where: {
          organizationId_name: { organizationId: tenant.organizationId, name: trimmed },
        },
        update: {},
        create: { organizationId: tenant.organizationId, name: trimmed },
        select: { id: true, name: true },
      });

      const attached = await tx.conversationTag.createMany({
        data: [{ conversationId, tagId: tag.id }],
        skipDuplicates: true,
      });

      if (attached.count === 1) {
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'CONVERSATION_TAG_ADDED',
            actorUserId: tenant.userId,
            metadata: { conversationId, tagId: tag.id, tagName: tag.name },
            context,
          },
          tx,
        );
      }

      return tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: CONVERSATION_PUBLIC_SELECT,
      });
    });
    this.emitConversationUpdated(result);
    return result;
  }

  async removeTag(
    tenant: TenantContext,
    conversationId: string,
    tagId: string,
    context: AuditActionContext,
  ): Promise<ConversationPublic> {
    await this.getForTenant(tenant, conversationId);

    // 404 pour un tag inexistant OU d'une autre organisation.
    const tag = await this.prisma.tag.findFirst({
      where: { id: tagId, organizationId: tenant.organizationId },
      select: { id: true, name: true },
    });
    if (!tag) {
      throw new TagNotFoundError();
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const detached = await tx.conversationTag.deleteMany({
        where: { conversationId, tagId: tag.id },
      });

      if (detached.count === 1) {
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'CONVERSATION_TAG_REMOVED',
            actorUserId: tenant.userId,
            metadata: { conversationId, tagId: tag.id, tagName: tag.name },
            context,
          },
          tx,
        );
      }

      return tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: CONVERSATION_PUBLIC_SELECT,
      });
    });
    this.emitConversationUpdated(result);
    return result;
  }
}
