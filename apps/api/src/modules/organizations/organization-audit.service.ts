import { Injectable, Logger } from '@nestjs/common';
import type { OrganizationAuditEventType, Prisma } from '@whauto/database';

import { PrismaService } from '../../prisma/prisma.service';

export interface AuditActionContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface OrganizationAuditInput {
  organizationId: string;
  eventType: OrganizationAuditEventType;
  actorUserId?: string | null;
  targetUserId?: string | null;
  /** Jamais de token, secret ou donnée sensible ici. */
  metadata?: Prisma.InputJsonValue;
  context?: AuditActionContext;
}

type PrismaClientLike = PrismaService | Prisma.TransactionClient;

@Injectable()
export class OrganizationAuditService {
  private readonly logger = new Logger(OrganizationAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Écriture STRUCTURANTE : à appeler avec le client transactionnel pour que
   * l'audit soit committé (ou annulé) avec l'action métier elle-même.
   * Événements concernés : ORGANIZATION_CREATED, ORGANIZATION_ARCHIVED,
   * INVITATION_ACCEPTED, MEMBER_ROLE_CHANGED, MEMBER_REMOVED, MEMBER_LEFT.
   */
  async record(input: OrganizationAuditInput, client: PrismaClientLike = this.prisma) {
    return client.organizationAuditEvent.create({
      data: {
        organizationId: input.organizationId,
        eventType: input.eventType,
        actorUserId: input.actorUserId ?? null,
        targetUserId: input.targetUserId ?? null,
        metadata: input.metadata,
        ipAddress: input.context?.ipAddress ?? null,
        userAgent: input.context?.userAgent ?? null,
      },
    });
  }

  /**
   * Écriture SECONDAIRE (hors transaction) : ne fait jamais échouer le flux
   * métier — ex. ORGANIZATION_UPDATED, MEMBER_INVITED, INVITATION_RESENT,
   * INVITATION_DECLINED, INVITATION_CANCELLED.
   */
  async recordSafe(input: OrganizationAuditInput): Promise<void> {
    try {
      await this.record(input);
    } catch (error) {
      this.logger.error(
        `Échec d'écriture de l'événement d'audit ${input.eventType} (org ${input.organizationId})`,
        error,
      );
    }
  }
}
