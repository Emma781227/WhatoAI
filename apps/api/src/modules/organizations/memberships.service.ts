import { Injectable } from '@nestjs/common';
import type { MembershipRole } from '@whauto/database';
import {
  CannotLeaveAsOwnerError,
  CannotRemoveOwnerError,
  InvalidRoleTransitionError,
  MembershipNotFoundError,
} from '@whauto/shared';

import { canActOnRole, canAssignRole } from '../../common/tenant/permissions';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import type { AuditActionContext } from './organization-audit.service';
import { OrganizationAuditService } from './organization-audit.service';
import { MEMBER_PUBLIC_SELECT } from './organizations.mapper';
import type { MemberPublic } from './organizations.mapper';
import type { PaginationQueryDto } from './dto/pagination.dto';

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(
    tenant: TenantContext,
    pagination: PaginationQueryDto,
  ): Promise<{ items: MemberPublic[]; total: number }> {
    // Seuls les membres ACTIVE sont listés — LEFT est conservé en base pour
    // l'audit et la réactivation, pas pour l'affichage.
    const where = { organizationId: tenant.organizationId, status: 'ACTIVE' as const };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.membership.findMany({
        where,
        select: MEMBER_PUBLIC_SELECT,
        orderBy: { joinedAt: 'asc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.membership.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Changement de rôle avec hiérarchie stricte (validée) :
   * - la cible doit porter un rôle STRICTEMENT inférieur à celui de l'acteur
   *   (donc OWNER intouchable, ADMIN intouchable par un autre ADMIN) ;
   * - le nouveau rôle doit aussi être STRICTEMENT inférieur (jamais de
   *   promotion OWNER ; un ADMIN n'assigne que MANAGER/AGENT) ;
   * - on ne modifie pas son propre rôle.
   *
   * Concurrence : updateMany conditionnel sur (id, organizationId, status,
   * role attendu) — si le rôle de la cible change entre la lecture et
   * l'écriture, count=0 et l'opération est rejouable proprement. L'index
   * partiel PostgreSQL (un seul OWNER ACTIVE) reste le garde-fou ultime.
   */
  async updateRole(
    tenant: TenantContext,
    membershipId: string,
    newRole: MembershipRole,
    context: AuditActionContext,
  ): Promise<MemberPublic> {
    const target = await this.findActiveMember(tenant, membershipId);

    if (target.userId === tenant.userId) {
      throw new InvalidRoleTransitionError('you cannot change your own role');
    }
    if (target.role === 'OWNER') {
      throw new InvalidRoleTransitionError('the owner role cannot be changed via this endpoint');
    }
    if (!canActOnRole(tenant.role, target.role)) {
      throw new InvalidRoleTransitionError(
        `role ${tenant.role} cannot manage a member with role ${target.role}`,
      );
    }
    if (newRole === 'OWNER' || !canAssignRole(tenant.role, newRole)) {
      throw new InvalidRoleTransitionError(`role ${tenant.role} cannot assign role ${newRole}`);
    }
    if (target.role === newRole) {
      return target;
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.membership.updateMany({
        where: {
          id: membershipId,
          organizationId: tenant.organizationId,
          status: 'ACTIVE',
          role: target.role,
        },
        data: { role: newRole },
      });
      if (updated.count !== 1) {
        // Modifié ou retiré concurremment depuis notre lecture.
        throw new MembershipNotFoundError();
      }

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'MEMBER_ROLE_CHANGED',
          actorUserId: tenant.userId,
          targetUserId: target.userId,
          metadata: { from: target.role, to: newRole },
          context,
        },
        tx,
      );

      return tx.membership.findUniqueOrThrow({
        where: { id: membershipId },
        select: MEMBER_PUBLIC_SELECT,
      });
    });
  }

  /**
   * Retrait d'un membre : Membership conservé en status=LEFT (audit,
   * réactivation possible sur réinvitation). Mêmes règles hiérarchiques.
   */
  async remove(
    tenant: TenantContext,
    membershipId: string,
    context: AuditActionContext,
  ): Promise<void> {
    const target = await this.findActiveMember(tenant, membershipId);

    if (target.userId === tenant.userId) {
      throw new InvalidRoleTransitionError('use the leave endpoint to remove yourself');
    }
    if (target.role === 'OWNER') {
      throw new CannotRemoveOwnerError();
    }
    if (!canActOnRole(tenant.role, target.role)) {
      throw new InvalidRoleTransitionError(
        `role ${tenant.role} cannot remove a member with role ${target.role}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const removed = await tx.membership.updateMany({
        where: {
          id: membershipId,
          organizationId: tenant.organizationId,
          status: 'ACTIVE',
          role: { not: 'OWNER' },
        },
        data: { status: 'LEFT' },
      });
      if (removed.count !== 1) {
        throw new MembershipNotFoundError();
      }

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'MEMBER_REMOVED',
          actorUserId: tenant.userId,
          targetUserId: target.userId,
          metadata: { role: target.role },
          context,
        },
        tx,
      );
    });

    // Éviction temps réel immédiate : le user retiré quitte les rooms de
    // l'organisation sans attendre l'expiration de son access token.
    await this.realtime.evictUserFromOrganization(target.userId, tenant.organizationId);
  }

  /**
   * Départ volontaire. Un OWNER ne peut pas quitter tant qu'il est
   * propriétaire (pas de transfert dans cette phase — validé).
   */
  async leave(tenant: TenantContext, context: AuditActionContext): Promise<void> {
    if (tenant.role === 'OWNER') {
      throw new CannotLeaveAsOwnerError();
    }

    await this.prisma.$transaction(async (tx) => {
      const left = await tx.membership.updateMany({
        where: {
          id: tenant.membershipId,
          organizationId: tenant.organizationId,
          status: 'ACTIVE',
          role: { not: 'OWNER' },
        },
        data: { status: 'LEFT' },
      });
      if (left.count !== 1) {
        throw new MembershipNotFoundError();
      }

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'MEMBER_LEFT',
          actorUserId: tenant.userId,
          targetUserId: tenant.userId,
          metadata: { role: tenant.role },
          context,
        },
        tx,
      );
    });

    await this.realtime.evictUserFromOrganization(tenant.userId, tenant.organizationId);
  }

  private async findActiveMember(
    tenant: TenantContext,
    membershipId: string,
  ): Promise<MemberPublic> {
    // organizationId dans le filtre : un membershipId d'un autre tenant est introuvable.
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, organizationId: tenant.organizationId, status: 'ACTIVE' },
      select: MEMBER_PUBLIC_SELECT,
    });
    if (!membership) {
      throw new MembershipNotFoundError();
    }
    return membership;
  }
}
