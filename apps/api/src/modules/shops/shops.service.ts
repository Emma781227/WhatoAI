import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import type { BusinessType, ShopStatus } from '@whauto/database';
import {
  ConflictError,
  InvalidShopStatusTransitionError,
  ShopActivationRequirementsError,
  ShopArchivedError,
  ShopNotFoundError,
  ShopSlugAlreadyUsedError,
  ValidationError,
} from '@whauto/shared';

import { isValidSlug, slugify, suffixedSlug } from '../../common/slug.util';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import { SHOP_PUBLIC_SELECT } from './shops.mapper';
import type { ShopPublic } from './shops.mapper';

export interface CreateShopInput {
  name: string;
  slug?: string;
  description?: string;
  businessType?: BusinessType;
  countryCode: string;
  timezone?: string;
  currency?: string;
  locale?: string;
}

/**
 * Convention PATCH (validée) : `undefined` = champ inchangé, `null` = effacement
 * d'un champ optionnel. Les champs requis (name, slug, countryCode, timezone,
 * currency, locale) ne sont jamais nullables.
 */
export interface UpdateShopInput {
  name?: string;
  slug?: string;
  description?: string | null;
  businessType?: BusinessType | null;
  logoUrl?: string | null;
  coverUrl?: string | null;
  websiteUrl?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  countryCode?: string;
  timezone?: string;
  currency?: string;
  locale?: string;
  returnPolicy?: string | null;
  deliveryPolicy?: string | null;
  orderInstructions?: string | null;
}

export interface ListShopsQuery {
  page: number;
  limit: number;
  skip: number;
  search?: string;
  status?: ShopStatus;
  businessType?: BusinessType;
  isPrimary?: boolean;
  includeArchived?: boolean;
  sortBy: 'createdAt' | 'name' | 'updatedAt';
  sortOrder: 'asc' | 'desc';
}

const MAX_GENERATED_SLUG_ATTEMPTS = 5;

/** Champs minimums requis pour activer une boutique (point d'extension futur). */
const ACTIVATION_REQUIRED_FIELDS = [
  'name',
  'countryCode',
  'timezone',
  'currency',
  'locale',
] as const;

const ALLOWED_TRANSITIONS: Readonly<Record<ShopStatus, readonly ShopStatus[]>> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [], // terminal
};

/**
 * Distinction précise des violations d'unicité (exigence validée) :
 * - la contrainte [organizationId, slug] remonte `meta.target` en tableau de
 *   colonnes contenant "slug" ;
 * - l'index partiel shops_one_primary_per_org est inconnu du schéma Prisma —
 *   son P2002 remonte le nom de l'index (ou rien) mais jamais "slug".
 * Aucun message Prisma brut ne sort : chaque cas est traduit en DomainError,
 * et un P2002 non identifié est relancé tel quel (500 générique NestJS).
 */
function uniqueViolationTarget(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.join(',');
  }
  return typeof target === 'string' ? target : '';
}

function isSlugConflict(error: unknown): boolean {
  const target = uniqueViolationTarget(error);
  return target !== null && target.includes('slug');
}

function isPrimaryConflict(error: unknown): boolean {
  const target = uniqueViolationTarget(error);
  if (target === null || target.includes('slug')) {
    return false;
  }
  // Forme réelle vérifiée (Prisma 6.19 + index partiel brut) :
  // meta.target = ["organizationId"]. On accepte aussi le nom d'index ou une
  // cible vide par robustesse. La table shops n'a que deux contraintes
  // uniques (hors PK) : [organizationId, slug] — écartée ci-dessus — et
  // l'index partiel de Shop principale : tout autre P2002 est donc lui.
  return true;
}

/** P2034 : conflit d'écriture/deadlock entre transactions interactives — retryable. */
function isWriteConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

@Injectable()
export class ShopsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
  ) {}

  // ------------------------------------------------------------------- create

  /**
   * Création transactionnelle : Shop + audit SHOP_CREATED. La première Shop
   * non archivée de l'organisation devient automatiquement principale.
   *
   * Concurrence — deux protections PostgreSQL distinctes, jamais confondues :
   * - collision de slug : 409 (slug fourni) ou retry suffixé (slug généré) ;
   * - collision de Shop principale (deux "premières" créations simultanées) :
   *   retry unique avec isPrimary=false, sans toucher au slug.
   */
  async create(
    tenant: TenantContext,
    input: CreateShopInput,
    context: AuditActionContext,
  ): Promise<ShopPublic> {
    const slugWasProvided = input.slug !== undefined;
    let slug = slugWasProvided ? input.slug!.trim().toLowerCase() : slugify(input.name);
    if (!isValidSlug(slug)) {
      throw new ValidationError(
        slugWasProvided
          ? 'Slug must be 2-50 characters, lowercase letters, digits and single hyphens.'
          : 'Shop name cannot be turned into a valid slug.',
      );
    }

    // Héritage des paramètres régionaux de l'Organization si absents.
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: tenant.organizationId },
      select: { timezone: true, defaultCurrency: true, defaultLocale: true },
    });
    const regional = {
      countryCode: input.countryCode.toUpperCase(),
      timezone: input.timezone ?? organization.timezone,
      currency: (input.currency ?? organization.defaultCurrency).toUpperCase(),
      locale: input.locale ?? organization.defaultLocale,
    };

    const existingPrimary = await this.prisma.shop.findFirst({
      where: {
        organizationId: tenant.organizationId,
        isPrimary: true,
        status: { not: 'ARCHIVED' },
      },
      select: { id: true },
    });
    let wantPrimary = existingPrimary === null;

    const baseSlug = slug;
    let slugAttempt = 1;
    // Deux compteurs indépendants : une collision de slug ne déclenche jamais
    // le repli isPrimary=false, et inversement.
    let primaryRetryDone = false;

    for (;;) {
      try {
        return await this.createWithValues(tenant, input, slug, regional, wantPrimary, context);
      } catch (error) {
        if (isSlugConflict(error)) {
          if (slugWasProvided || slugAttempt >= MAX_GENERATED_SLUG_ATTEMPTS) {
            throw new ShopSlugAlreadyUsedError();
          }
          slugAttempt += 1;
          slug = suffixedSlug(baseSlug, slugAttempt);
          continue;
        }
        if (isPrimaryConflict(error) && wantPrimary && !primaryRetryDone) {
          // Une création concurrente a pris la place de principale.
          wantPrimary = false;
          primaryRetryDone = true;
          continue;
        }
        throw error;
      }
    }
  }

  private async createWithValues(
    tenant: TenantContext,
    input: CreateShopInput,
    slug: string,
    regional: { countryCode: string; timezone: string; currency: string; locale: string },
    isPrimary: boolean,
    context: AuditActionContext,
  ): Promise<ShopPublic> {
    return this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.create({
        data: {
          organizationId: tenant.organizationId,
          name: input.name.trim(),
          slug,
          description: input.description ?? null,
          businessType: input.businessType ?? null,
          isPrimary,
          ...regional,
          createdByUserId: tenant.userId,
        },
        select: SHOP_PUBLIC_SELECT,
      });

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'SHOP_CREATED',
          actorUserId: tenant.userId,
          metadata: { shopId: shop.id, name: shop.name, slug: shop.slug, isPrimary },
          context,
        },
        tx,
      );

      return shop;
    });
  }

  // --------------------------------------------------------------------- read

  async list(
    tenant: TenantContext,
    query: ListShopsQuery,
  ): Promise<{ items: ShopPublic[]; total: number }> {
    const where: Prisma.ShopWhereInput = { organizationId: tenant.organizationId };

    if (query.status !== undefined) {
      where.status = query.status;
    } else if (query.includeArchived !== true) {
      // Les Shops archivées sont exclues des listes opérationnelles par défaut.
      where.status = { not: 'ARCHIVED' };
    }
    if (query.businessType !== undefined) {
      where.businessType = query.businessType;
    }
    if (query.isPrimary !== undefined) {
      where.isPrimary = query.isPrimary;
    }
    if (query.search !== undefined && query.search.trim() !== '') {
      const search = query.search.trim();
      // Recherche insensible à la casse, toujours à l'intérieur du where
      // tenant-scopé (le OR ne peut pas élargir au-delà de l'organizationId).
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.shop.findMany({
        where,
        select: SHOP_PUBLIC_SELECT,
        orderBy: { [query.sortBy]: query.sortOrder },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.shop.count({ where }),
    ]);
    return { items, total };
  }

  /** Une Shop archivée reste consultable (lecture seule) avec shops.read. */
  async getForTenant(tenant: TenantContext, shopId: string): Promise<ShopPublic> {
    const shop = await this.prisma.shop.findFirst({
      where: { id: shopId, organizationId: tenant.organizationId },
      select: SHOP_PUBLIC_SELECT,
    });
    if (!shop) {
      throw new ShopNotFoundError();
    }
    return shop;
  }

  // ------------------------------------------------------------------- update

  /**
   * Audit SHOP_UPDATED dans la MÊME transaction que la modification (validé) :
   * un échec d'écriture d'audit annule la modification.
   */
  async update(
    tenant: TenantContext,
    shopId: string,
    input: UpdateShopInput,
    context: AuditActionContext,
  ): Promise<ShopPublic> {
    const current = await this.getForTenant(tenant, shopId);
    if (current.status === 'ARCHIVED') {
      throw new ShopArchivedError();
    }

    const data = this.buildUpdateData(input);
    if (Object.keys(data).length === 0) {
      throw new ValidationError('No updatable field provided.');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Conditionnel sur status : une Shop archivée concurremment n'est pas modifiée.
        const updated = await tx.shop.updateMany({
          where: { id: shopId, organizationId: tenant.organizationId, status: { not: 'ARCHIVED' } },
          data,
        });
        if (updated.count !== 1) {
          throw new ShopArchivedError();
        }

        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'SHOP_UPDATED',
            actorUserId: tenant.userId,
            // Noms des champs modifiés uniquement — jamais le contenu
            // (les politiques peuvent faire 2000 caractères).
            metadata: { shopId, fields: Object.keys(data) },
            context,
          },
          tx,
        );

        return tx.shop.findUniqueOrThrow({ where: { id: shopId }, select: SHOP_PUBLIC_SELECT });
      });
    } catch (error) {
      if (isSlugConflict(error)) {
        throw new ShopSlugAlreadyUsedError();
      }
      throw error;
    }
  }

  private buildUpdateData(input: UpdateShopInput): Prisma.ShopUpdateInput {
    const data: Prisma.ShopUpdateInput = {};

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
    if (input.countryCode !== undefined) {
      data.countryCode = input.countryCode.toUpperCase();
    }
    if (input.timezone !== undefined) {
      data.timezone = input.timezone;
    }
    if (input.currency !== undefined) {
      data.currency = input.currency.toUpperCase();
    }
    if (input.locale !== undefined) {
      data.locale = input.locale;
    }

    // Champs optionnels : undefined = inchangé, null = effacement (convention validée).
    const clearableFields = [
      'description',
      'businessType',
      'logoUrl',
      'coverUrl',
      'websiteUrl',
      'supportEmail',
      'supportPhone',
      'addressLine1',
      'addressLine2',
      'city',
      'region',
      'postalCode',
      'latitude',
      'longitude',
      'returnPolicy',
      'deliveryPolicy',
      'orderInstructions',
    ] as const;
    for (const field of clearableFields) {
      if (input[field] !== undefined) {
        (data as Record<string, unknown>)[field] = input[field];
      }
    }

    return data;
  }

  // -------------------------------------------------------------- transitions

  async activate(
    tenant: TenantContext,
    shopId: string,
    context: AuditActionContext,
  ): Promise<ShopPublic> {
    const current = await this.getForTenant(tenant, shopId);
    this.assertTransition(current.status, 'ACTIVE');

    const missing = ACTIVATION_REQUIRED_FIELDS.filter((field) => {
      const value = current[field];
      return typeof value !== 'string' || value.trim() === '';
    });
    if (missing.length > 0) {
      throw new ShopActivationRequirementsError([...missing]);
    }

    return this.transition(tenant, shopId, current.status, 'ACTIVE', 'SHOP_ACTIVATED', context);
  }

  async deactivate(
    tenant: TenantContext,
    shopId: string,
    context: AuditActionContext,
  ): Promise<ShopPublic> {
    const current = await this.getForTenant(tenant, shopId);
    this.assertTransition(current.status, 'INACTIVE');
    return this.transition(tenant, shopId, current.status, 'INACTIVE', 'SHOP_DEACTIVATED', context);
  }

  private assertTransition(from: ShopStatus, to: ShopStatus): void {
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new InvalidShopStatusTransitionError(from, to);
    }
  }

  private async transition(
    tenant: TenantContext,
    shopId: string,
    from: ShopStatus,
    to: ShopStatus,
    eventType: 'SHOP_ACTIVATED' | 'SHOP_DEACTIVATED',
    context: AuditActionContext,
  ): Promise<ShopPublic> {
    return this.prisma.$transaction(async (tx) => {
      // Conditionnel sur le statut lu : une transition concurrente → count=0.
      const updated = await tx.shop.updateMany({
        where: { id: shopId, organizationId: tenant.organizationId, status: from },
        data: { status: to },
      });
      if (updated.count !== 1) {
        throw new InvalidShopStatusTransitionError(from, to);
      }

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType,
          actorUserId: tenant.userId,
          metadata: { shopId, from, to },
          context,
        },
        tx,
      );

      return tx.shop.findUniqueOrThrow({ where: { id: shopId }, select: SHOP_PUBLIC_SELECT });
    });
  }

  // -------------------------------------------------------------- set-primary

  /**
   * Idempotent si déjà principale. Transaction : démotion de l'ancienne
   * principale + promotion conditionnelle + audit — un échec en cours de route
   * annule tout (jamais d'organisation laissée sans principale par une erreur
   * partielle). L'index partiel PostgreSQL reste le garde-fou : en cas de
   * course avec un autre set-primary, un retry unique rejoue la transaction.
   */
  async setPrimary(
    tenant: TenantContext,
    shopId: string,
    context: AuditActionContext,
  ): Promise<ShopPublic> {
    const current = await this.getForTenant(tenant, shopId);
    if (current.status === 'ARCHIVED') {
      throw new ShopArchivedError();
    }
    if (current.isPrimary) {
      return current; // Idempotent.
    }

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await tx.shop.updateMany({
            where: { organizationId: tenant.organizationId, isPrimary: true },
            data: { isPrimary: false },
          });

          const promoted = await tx.shop.updateMany({
            where: {
              id: shopId,
              organizationId: tenant.organizationId,
              status: { not: 'ARCHIVED' },
            },
            data: { isPrimary: true },
          });
          if (promoted.count !== 1) {
            // Archivée concurremment : la transaction annule aussi la démotion.
            throw new ShopArchivedError();
          }

          await this.auditService.record(
            {
              organizationId: tenant.organizationId,
              eventType: 'SHOP_SET_PRIMARY',
              actorUserId: tenant.userId,
              metadata: { shopId },
              context,
            },
            tx,
          );

          return tx.shop.findUniqueOrThrow({ where: { id: shopId }, select: SHOP_PUBLIC_SELECT });
        });
      } catch (error) {
        // Retry ciblé : violation de l'index primaire (P2002) ou conflit
        // d'écriture entre transactions (P2034) — jamais sur une autre erreur.
        const retryable = isPrimaryConflict(error) || isWriteConflict(error);
        if (retryable && attempt < 3) {
          continue;
        }
        if (retryable) {
          throw new ConflictError('Concurrent primary shop change. Please retry.');
        }
        throw error;
      }
    }
  }

  // ------------------------------------------------------------------ archive

  /**
   * Archivage terminal : status=ARCHIVED, archivedAt, isPrimary=false. Si la
   * Shop était principale, promotion déterministe dans la même transaction :
   * plus ancienne ACTIVE, sinon plus ancienne INACTIVE, sinon plus ancienne
   * DRAFT (ordre secondaire par id) — sinon aucune principale (validé).
   */
  async archive(
    tenant: TenantContext,
    shopId: string,
    context: AuditActionContext,
  ): Promise<ShopPublic> {
    const current = await this.getForTenant(tenant, shopId);
    if (current.status === 'ARCHIVED') {
      throw new InvalidShopStatusTransitionError('ARCHIVED', 'ARCHIVED');
    }

    return this.prisma.$transaction(async (tx) => {
      const archived = await tx.shop.updateMany({
        where: { id: shopId, organizationId: tenant.organizationId, status: { not: 'ARCHIVED' } },
        data: { status: 'ARCHIVED', archivedAt: new Date(), isPrimary: false },
      });
      if (archived.count !== 1) {
        throw new InvalidShopStatusTransitionError('ARCHIVED', 'ARCHIVED');
      }

      let promotedShopId: string | null = null;
      if (current.isPrimary) {
        const candidate = await this.findPromotionCandidate(tx, tenant.organizationId);
        if (candidate) {
          await tx.shop.update({
            where: { id: candidate.id },
            data: { isPrimary: true },
            select: { id: true },
          });
          promotedShopId = candidate.id;
        }
      }

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'SHOP_ARCHIVED',
          actorUserId: tenant.userId,
          metadata: { shopId, wasPrimary: current.isPrimary, promotedShopId },
          context,
        },
        tx,
      );

      return tx.shop.findUniqueOrThrow({ where: { id: shopId }, select: SHOP_PUBLIC_SELECT });
    });
  }

  /** Priorité ACTIVE > INACTIVE > DRAFT, puis plus ancienne (createdAt, id). */
  private async findPromotionCandidate(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<{ id: string } | null> {
    for (const status of ['ACTIVE', 'INACTIVE', 'DRAFT'] as const) {
      const candidate = await tx.shop.findFirst({
        where: { organizationId, status },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }
}
