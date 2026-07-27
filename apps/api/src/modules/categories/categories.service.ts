import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import type { ProductCategoryStatus } from '@whauto/database';
import {
  CategoryArchivedError,
  CategoryNameAlreadyUsedError,
  CategoryNotFoundError,
  CategorySlugAlreadyUsedError,
  ShopArchivedError,
  ShopNotFoundError,
  ValidationError,
} from '@whauto/shared';

import { isValidSlug, slugify, suffixedSlug } from '../../common/slug.util';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import { CATEGORY_PUBLIC_SELECT } from './categories.mapper';
import type { CategoryPublic } from './categories.mapper';

export interface CreateCategoryInput {
  name: string;
  slug?: string;
  description?: string;
  imageUrl?: string;
  sortOrder?: number;
}

export interface UpdateCategoryInput {
  name?: string;
  slug?: string;
  description?: string | null;
  imageUrl?: string | null;
  sortOrder?: number;
  status?: 'ACTIVE' | 'INACTIVE';
}

export interface ListCategoriesQuery {
  page: number;
  limit: number;
  skip: number;
  search?: string;
  status?: ProductCategoryStatus;
  includeArchived?: boolean;
  sortBy: 'name' | 'createdAt' | 'sortOrder';
  sortOrderDir: 'asc' | 'desc';
}

const MAX_GENERATED_SLUG_ATTEMPTS = 5;

/**
 * Distinction des violations d'unicité :
 * - @@unique([shopId, slug]) remonte meta.target contenant "slug" ;
 * - l'index partiel CI sur lower(name) est inconnu du schéma Prisma — son
 *   P2002 remonte les colonnes ou rien, jamais "slug" (piège documenté).
 */
function isSlugConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  return Array.isArray(target) && target.includes('slug');
}

function isNameConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    !isSlugConflict(error)
  );
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
  ) {}

  async create(
    tenant: TenantContext,
    shopId: string,
    input: CreateCategoryInput,
    context: AuditActionContext,
  ): Promise<CategoryPublic> {
    await this.getWritableShop(tenant, shopId);

    const slugWasProvided = input.slug !== undefined;
    let slug = slugWasProvided ? input.slug!.trim().toLowerCase() : slugify(input.name);
    if (!isValidSlug(slug)) {
      throw new ValidationError(
        slugWasProvided
          ? 'Slug must be 2-50 characters, lowercase letters, digits and single hyphens.'
          : 'Category name cannot be turned into a valid slug.',
      );
    }

    const baseSlug = slug;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const category = await tx.productCategory.create({
            data: {
              organizationId: tenant.organizationId,
              shopId,
              name: input.name.trim(),
              slug,
              description: input.description ?? null,
              imageUrl: input.imageUrl ?? null,
              sortOrder: input.sortOrder ?? 0,
            },
            select: CATEGORY_PUBLIC_SELECT,
          });

          await this.auditService.record(
            {
              organizationId: tenant.organizationId,
              eventType: 'CATEGORY_CREATED',
              actorUserId: tenant.userId,
              metadata: { categoryId: category.id, shopId, name: category.name, slug: category.slug },
              context,
            },
            tx,
          );
          return category;
        });
      } catch (error) {
        if (isSlugConflict(error)) {
          if (slugWasProvided || attempt >= MAX_GENERATED_SLUG_ATTEMPTS) {
            throw new CategorySlugAlreadyUsedError();
          }
          slug = suffixedSlug(baseSlug, attempt + 1);
          continue;
        }
        if (isNameConflict(error)) {
          throw new CategoryNameAlreadyUsedError();
        }
        throw error;
      }
    }
  }

  async list(
    tenant: TenantContext,
    shopId: string,
    query: ListCategoriesQuery,
  ): Promise<{ items: CategoryPublic[]; total: number }> {
    await this.getShop(tenant, shopId);

    const where: Prisma.ProductCategoryWhereInput = {
      organizationId: tenant.organizationId,
      shopId,
    };
    if (query.status !== undefined) {
      where.status = query.status;
    } else if (query.includeArchived !== true) {
      where.status = { not: 'ARCHIVED' };
    }
    if (query.search !== undefined && query.search.trim() !== '') {
      const search = query.search.trim();
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { slug: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.productCategory.findMany({
        where,
        select: CATEGORY_PUBLIC_SELECT,
        orderBy: [{ [query.sortBy]: query.sortOrderDir }, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.productCategory.count({ where }),
    ]);
    return { items, total };
  }

  async getForTenant(
    tenant: TenantContext,
    shopId: string,
    categoryId: string,
  ): Promise<CategoryPublic> {
    const category = await this.prisma.productCategory.findFirst({
      where: { id: categoryId, organizationId: tenant.organizationId, shopId },
      select: CATEGORY_PUBLIC_SELECT,
    });
    if (!category) {
      throw new CategoryNotFoundError();
    }
    return category;
  }

  async update(
    tenant: TenantContext,
    shopId: string,
    categoryId: string,
    input: UpdateCategoryInput,
    context: AuditActionContext,
  ): Promise<CategoryPublic> {
    await this.getWritableShop(tenant, shopId);
    const current = await this.getForTenant(tenant, shopId, categoryId);
    if (current.status === 'ARCHIVED') {
      throw new CategoryArchivedError();
    }

    const data: Prisma.ProductCategoryUpdateManyMutationInput = {};
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
    if (input.description !== undefined) {
      data.description = input.description;
    }
    if (input.imageUrl !== undefined) {
      data.imageUrl = input.imageUrl;
    }
    if (input.sortOrder !== undefined) {
      data.sortOrder = input.sortOrder;
    }
    if (input.status !== undefined) {
      data.status = input.status;
    }
    if (Object.keys(data).length === 0) {
      throw new ValidationError('No updatable field provided.');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.productCategory.updateMany({
          where: {
            id: categoryId,
            organizationId: tenant.organizationId,
            shopId,
            status: { not: 'ARCHIVED' },
          },
          data,
        });
        if (updated.count !== 1) {
          throw new CategoryArchivedError();
        }

        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'CATEGORY_UPDATED',
            actorUserId: tenant.userId,
            metadata: { categoryId, shopId, fields: Object.keys(data) },
            context,
          },
          tx,
        );

        return tx.productCategory.findUniqueOrThrow({
          where: { id: categoryId },
          select: CATEGORY_PUBLIC_SELECT,
        });
      });
    } catch (error) {
      if (isSlugConflict(error)) {
        throw new CategorySlugAlreadyUsedError();
      }
      if (isNameConflict(error)) {
        throw new CategoryNameAlreadyUsedError();
      }
      throw error;
    }
  }

  /**
   * Archivage terminal. Les produits CONSERVENT leur categoryId (décision
   * validée — historique) : la catégorie n'est simplement plus proposée ni
   * assignable, et le détail produit affiche son état archivé.
   */
  async archive(
    tenant: TenantContext,
    shopId: string,
    categoryId: string,
    context: AuditActionContext,
  ): Promise<CategoryPublic> {
    await this.getWritableShop(tenant, shopId);
    await this.getForTenant(tenant, shopId, categoryId);

    return this.prisma.$transaction(async (tx) => {
      const archived = await tx.productCategory.updateMany({
        where: {
          id: categoryId,
          organizationId: tenant.organizationId,
          shopId,
          status: { not: 'ARCHIVED' },
        },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });
      if (archived.count !== 1) {
        throw new CategoryArchivedError();
      }

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'CATEGORY_ARCHIVED',
          actorUserId: tenant.userId,
          metadata: { categoryId, shopId },
          context,
        },
        tx,
      );

      return tx.productCategory.findUniqueOrThrow({
        where: { id: categoryId },
        select: CATEGORY_PUBLIC_SELECT,
      });
    });
  }

  // ------------------------------------------------------------------ helpers

  private async getShop(tenant: TenantContext, shopId: string) {
    const shop = await this.prisma.shop.findFirst({
      where: { id: shopId, organizationId: tenant.organizationId },
      select: { id: true, status: true, currency: true },
    });
    if (!shop) {
      throw new ShopNotFoundError();
    }
    return shop;
  }

  private async getWritableShop(tenant: TenantContext, shopId: string) {
    const shop = await this.getShop(tenant, shopId);
    if (shop.status === 'ARCHIVED') {
      throw new ShopArchivedError();
    }
    return shop;
  }
}
