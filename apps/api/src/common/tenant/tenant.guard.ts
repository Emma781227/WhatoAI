import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AmbiguousOrganizationSelectorError,
  OrganizationArchivedError,
  OrganizationNotFoundError,
  OrganizationSuspendedError,
} from '@whauto/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { ALLOW_ARCHIVED_KEY } from './allow-archived.decorator';
import { ROLE_PERMISSIONS } from './permissions';
import type { RequestWithTenant } from './tenant-context.interface';

export const ORGANIZATION_ID_HEADER = 'x-organization-id';

/**
 * Construit le TenantContext. À poser APRÈS JwtAuthGuard.
 *
 * Résolution de l'organisation ciblée :
 * - path param `:organizationId` (contrat de cette phase) ;
 * - header `X-Organization-Id` (futurs modules à routes plates) ;
 * - les deux présents et différents → 400 (jamais de choix silencieux).
 *
 * L'identifiant fourni n'est qu'une désignation, jamais une preuve d'accès :
 * le Membership ACTIVE est systématiquement vérifié en base. Un non-membre
 * reçoit 404 (anti-énumération), exactement comme une organisation inexistante.
 * Un membership LEFT/SUSPENDED reçoit aussi 404 : il n'a plus aucun accès.
 *
 * Statut d'organisation : SUSPENDED bloque tout ; ARCHIVED bloque tout sauf
 * les routes marquées @AllowArchived (lecture seule).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithTenant>();

    const organizationId = this.resolveOrganizationId(request);
    if (!organizationId) {
      throw new OrganizationNotFoundError();
    }

    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId: request.user.userId, organizationId },
      },
      select: {
        id: true,
        role: true,
        status: true,
        organization: { select: { status: true } },
      },
    });

    if (!membership || membership.status !== 'ACTIVE') {
      throw new OrganizationNotFoundError();
    }

    if (membership.organization.status === 'SUSPENDED') {
      throw new OrganizationSuspendedError();
    }

    if (membership.organization.status === 'ARCHIVED') {
      const allowArchived = this.reflector.getAllAndOverride<boolean>(ALLOW_ARCHIVED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (allowArchived !== true) {
        throw new OrganizationArchivedError();
      }
    }

    request.tenant = {
      userId: request.user.userId,
      organizationId,
      membershipId: membership.id,
      role: membership.role,
      permissions: ROLE_PERMISSIONS[membership.role],
    };
    return true;
  }

  private resolveOrganizationId(request: RequestWithTenant): string | undefined {
    const params = request.params as Record<string, string | undefined>;
    const fromPath = params.organizationId;

    const rawHeader = request.headers[ORGANIZATION_ID_HEADER];
    const fromHeader = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (fromPath && fromHeader && fromPath !== fromHeader) {
      throw new AmbiguousOrganizationSelectorError();
    }
    return fromPath ?? fromHeader;
  }
}
