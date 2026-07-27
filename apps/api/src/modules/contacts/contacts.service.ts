import { Injectable } from '@nestjs/common';
import type { ContactStatus, Prisma } from '@whauto/database';
import { ContactNotFoundError, ValidationError } from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { CONTACT_PUBLIC_SELECT } from './contacts.mapper';
import type { ContactPublic } from './contacts.mapper';

export interface ListContactsQuery {
  page: number;
  limit: number;
  skip: number;
  shopId?: string;
  search?: string;
  status?: ContactStatus;
}

export interface UpdateContactInput {
  displayName?: string | null;
  email?: string | null;
  language?: string | null;
  city?: string | null;
  countryCode?: string | null;
  notes?: string | null;
}

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    tenant: TenantContext,
    query: ListContactsQuery,
  ): Promise<{ items: ContactPublic[]; total: number }> {
    const where: Prisma.ContactWhereInput = { organizationId: tenant.organizationId };

    if (query.shopId !== undefined) {
      where.shopId = query.shopId;
    }
    if (query.status !== undefined) {
      where.status = query.status;
    }
    if (query.search !== undefined && query.search.trim() !== '') {
      const search = query.search.trim();
      // Toujours à l'intérieur du where tenant-scopé.
      where.OR = [
        { displayName: { contains: search, mode: 'insensitive' } },
        { normalizedPhone: { contains: search } },
        { whatsappPhone: { contains: search } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.contact.findMany({
        where,
        select: CONTACT_PUBLIC_SELECT,
        orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.contact.count({ where }),
    ]);
    return { items, total };
  }

  async getForTenant(tenant: TenantContext, contactId: string): Promise<ContactPublic> {
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, organizationId: tenant.organizationId },
      select: CONTACT_PUBLIC_SELECT,
    });
    if (!contact) {
      throw new ContactNotFoundError();
    }
    return contact;
  }

  async update(
    tenant: TenantContext,
    contactId: string,
    input: UpdateContactInput,
  ): Promise<ContactPublic> {
    await this.getForTenant(tenant, contactId);

    const data: Prisma.ContactUpdateInput = {};
    const clearableFields = [
      'displayName',
      'email',
      'language',
      'city',
      'countryCode',
      'notes',
    ] as const;
    for (const field of clearableFields) {
      if (input[field] !== undefined) {
        (data as Record<string, unknown>)[field] =
          field === 'countryCode' && typeof input[field] === 'string'
            ? input[field].toUpperCase()
            : input[field];
      }
    }
    if (Object.keys(data).length === 0) {
      throw new ValidationError('No updatable field provided.');
    }

    const updated = await this.prisma.contact.updateMany({
      where: { id: contactId, organizationId: tenant.organizationId },
      data,
    });
    if (updated.count !== 1) {
      throw new ContactNotFoundError();
    }
    return this.prisma.contact.findUniqueOrThrow({
      where: { id: contactId },
      select: CONTACT_PUBLIC_SELECT,
    });
  }
}
