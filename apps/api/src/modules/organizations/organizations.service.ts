import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import {
  OrganizationArchivedError,
  OrganizationNotFoundError,
  OrganizationSlugAlreadyUsedError,
  ValidationError,
} from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuditActionContext } from './organization-audit.service';
import { OrganizationAuditService } from './organization-audit.service';
import { ORGANIZATION_PUBLIC_SELECT } from './organizations.mapper';
import type { OrganizationPublic } from './organizations.mapper';
import { isValidSlug, slugify, suffixedSlug } from '../../common/slug.util';

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
  timezone?: string;
  defaultCurrency?: string;
  defaultLocale?: string;
}

export interface UpdateOrganizationInput {
  name?: string;
  slug?: string;
  timezone?: string;
  defaultCurrency?: string;
  defaultLocale?: string;
}

export interface OrganizationMembershipSummary {
  organization: OrganizationPublic;
  membershipId: string;
  role: string;
  joinedAt: Date;
}

const MAX_GENERATED_SLUG_ATTEMPTS = 5;

function isUniqueViolationOn(error: unknown, field: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    Array.isArray(error.meta?.target) &&
    (error.meta.target as string[]).includes(field)
  );
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
  ) {}

  /**
   * Création atomique : Organization + Membership OWNER ACTIVE + audit
   * ORGANIZATION_CREATED dans la même transaction. L'unicité du slug est
   * garantie par la contrainte PostgreSQL (deux créations concurrentes du
   * même slug : une seule passe) ; un slug auto-généré est retenté avec
   * suffixe en cas de collision.
   */
  async create(
    userId: string,
    input: CreateOrganizationInput,
    context: AuditActionContext,
  ): Promise<{ organization: OrganizationPublic; membershipId: string; role: 'OWNER' }> {
    const slugWasProvided = input.slug !== undefined;
    let slug = slugWasProvided ? input.slug!.trim().toLowerCase() : slugify(input.name);

    if (slugWasProvided && !isValidSlug(slug)) {
      throw new ValidationError(
        'Slug must be 2-50 characters, lowercase letters, digits and single hyphens.',
      );
    }
    if (!slugWasProvided && !isValidSlug(slug)) {
      // Nom sans aucun caractère alphanumérique translittérable.
      throw new ValidationError('Organization name cannot be turned into a valid slug.');
    }

    const baseSlug = slug;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.createWithSlug(userId, input, slug, context);
      } catch (error) {
        if (!isUniqueViolationOn(error, 'slug')) {
          throw error;
        }
        if (slugWasProvided || attempt >= MAX_GENERATED_SLUG_ATTEMPTS) {
          throw new OrganizationSlugAlreadyUsedError();
        }
        slug = suffixedSlug(baseSlug, attempt + 1);
      }
    }
  }

  private async createWithSlug(
    userId: string,
    input: CreateOrganizationInput,
    slug: string,
    context: AuditActionContext,
  ): Promise<{ organization: OrganizationPublic; membershipId: string; role: 'OWNER' }> {
    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: input.name.trim(),
          slug,
          createdByUserId: userId,
          ...(input.timezone !== undefined && { timezone: input.timezone }),
          ...(input.defaultCurrency !== undefined && {
            defaultCurrency: input.defaultCurrency.toUpperCase(),
          }),
          ...(input.defaultLocale !== undefined && { defaultLocale: input.defaultLocale }),
        },
        select: ORGANIZATION_PUBLIC_SELECT,
      });

      const membership = await tx.membership.create({
        data: { userId, organizationId: organization.id, role: 'OWNER', status: 'ACTIVE' },
        select: { id: true },
      });

      await this.auditService.record(
        {
          organizationId: organization.id,
          eventType: 'ORGANIZATION_CREATED',
          actorUserId: userId,
          metadata: { name: organization.name, slug: organization.slug },
          context,
        },
        tx,
      );

      return { organization, membershipId: membership.id, role: 'OWNER' as const };
    });
  }

  /** Organisations où l'utilisateur a un Membership ACTIVE (statut org visible, y compris ARCHIVED). */
  async listForUser(userId: string): Promise<OrganizationMembershipSummary[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: 'ACTIVE' },
      select: {
        id: true,
        role: true,
        joinedAt: true,
        organization: { select: ORGANIZATION_PUBLIC_SELECT },
      },
      orderBy: { joinedAt: 'asc' },
    });

    return memberships.map((membership) => ({
      organization: membership.organization,
      membershipId: membership.id,
      role: membership.role,
      joinedAt: membership.joinedAt,
    }));
  }

  async getForTenant(
    tenant: TenantContext,
  ): Promise<{ organization: OrganizationPublic; memberCount: number }> {
    const [organization, memberCount] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: tenant.organizationId },
        select: ORGANIZATION_PUBLIC_SELECT,
      }),
      this.prisma.membership.count({
        where: { organizationId: tenant.organizationId, status: 'ACTIVE' },
      }),
    ]);

    if (!organization) {
      throw new OrganizationNotFoundError();
    }
    return { organization, memberCount };
  }

  async update(
    tenant: TenantContext,
    input: UpdateOrganizationInput,
    context: AuditActionContext,
  ): Promise<OrganizationPublic> {
    const data: Prisma.OrganizationUpdateInput = {};
    if (input.name !== undefined) {
      data.name = input.name.trim();
    }
    if (input.slug !== undefined) {
      const slug = input.slug.trim().toLowerCase();
      if (!isValidSlug(slug)) {
        throw new ValidationError(
          'Slug must be 2-50 characters, lowercase letters, digits and single hyphens.',
        );
      }
      data.slug = slug;
    }
    if (input.timezone !== undefined) {
      data.timezone = input.timezone;
    }
    if (input.defaultCurrency !== undefined) {
      data.defaultCurrency = input.defaultCurrency.toUpperCase();
    }
    if (input.defaultLocale !== undefined) {
      data.defaultLocale = input.defaultLocale;
    }
    if (Object.keys(data).length === 0) {
      throw new ValidationError('No updatable field provided.');
    }

    try {
      const organization = await this.prisma.organization.update({
        where: { id: tenant.organizationId },
        data,
        select: ORGANIZATION_PUBLIC_SELECT,
      });

      await this.auditService.recordSafe({
        organizationId: tenant.organizationId,
        eventType: 'ORGANIZATION_UPDATED',
        actorUserId: tenant.userId,
        metadata: { fields: Object.keys(data) },
        context,
      });

      return organization;
    } catch (error) {
      if (isUniqueViolationOn(error, 'slug')) {
        throw new OrganizationSlugAlreadyUsedError();
      }
      throw error;
    }
  }

  /**
   * Archivage logique. updateMany conditionnel (status=ACTIVE) : un double
   * archivage concurrent ne passe qu'une fois ; audit dans la même transaction.
   */
  async archive(tenant: TenantContext, context: AuditActionContext): Promise<OrganizationPublic> {
    return this.prisma.$transaction(async (tx) => {
      const archived = await tx.organization.updateMany({
        where: { id: tenant.organizationId, status: 'ACTIVE' },
        data: { status: 'ARCHIVED' },
      });
      if (archived.count !== 1) {
        throw new OrganizationArchivedError();
      }

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'ORGANIZATION_ARCHIVED',
          actorUserId: tenant.userId,
          context,
        },
        tx,
      );

      return tx.organization.findUniqueOrThrow({
        where: { id: tenant.organizationId },
        select: ORGANIZATION_PUBLIC_SELECT,
      });
    });
  }
}
