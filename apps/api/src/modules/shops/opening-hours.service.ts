import { Injectable } from '@nestjs/common';
import { ShopArchivedError, ShopNotFoundError } from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import type { OpeningHourDayDto } from './dto/opening-hours.dto';
import { normalizeOpeningHours } from './opening-hours.util';
import { OPENING_HOUR_SELECT } from './shops.mapper';
import type { OpeningHourRow } from './shops.mapper';

@Injectable()
export class OpeningHoursService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OrganizationAuditService,
  ) {}

  async get(
    tenant: TenantContext,
    shopId: string,
  ): Promise<{ timezone: string; rows: OpeningHourRow[] }> {
    const shop = await this.findShop(tenant, shopId);
    const rows = await this.prisma.shopOpeningHour.findMany({
      where: { shopId },
      select: OPENING_HOUR_SELECT,
      orderBy: [{ dayOfWeek: 'asc' }, { opensAtMinutes: 'asc' }],
    });
    return { timezone: shop.timezone, rows };
  }

  /**
   * Remplacement complet transactionnel (validé) : deleteMany + createMany +
   * audit SHOP_OPENING_HOURS_UPDATED dans la MÊME transaction — un échec
   * d'audit annule le remplacement, jamais d'état mixte entre deux jeux
   * d'horaires. Le fuseau horaire est celui de la Shop, non modifiable ici.
   */
  async replace(
    tenant: TenantContext,
    shopId: string,
    days: OpeningHourDayDto[],
    context: AuditActionContext,
  ): Promise<{ timezone: string; rows: OpeningHourRow[] }> {
    const shop = await this.findShop(tenant, shopId);
    if (shop.status === 'ARCHIVED') {
      throw new ShopArchivedError();
    }

    const rows = normalizeOpeningHours(days);

    await this.prisma.$transaction(async (tx) => {
      await tx.shopOpeningHour.deleteMany({ where: { shopId } });
      if (rows.length > 0) {
        await tx.shopOpeningHour.createMany({
          data: rows.map((row) => ({ ...row, shopId })),
        });
      }

      await this.auditService.record(
        {
          organizationId: tenant.organizationId,
          eventType: 'SHOP_OPENING_HOURS_UPDATED',
          actorUserId: tenant.userId,
          // Synthétique : nombre de jours ouverts et de plages, jamais le détail.
          metadata: {
            shopId,
            openDays: new Set(rows.map((row) => row.dayOfWeek)).size,
            periods: rows.length,
          },
          context,
        },
        tx,
      );
    });

    const stored = await this.prisma.shopOpeningHour.findMany({
      where: { shopId },
      select: OPENING_HOUR_SELECT,
      orderBy: [{ dayOfWeek: 'asc' }, { opensAtMinutes: 'asc' }],
    });
    return { timezone: shop.timezone, rows: stored };
  }

  private async findShop(tenant: TenantContext, shopId: string) {
    const shop = await this.prisma.shop.findFirst({
      where: { id: shopId, organizationId: tenant.organizationId },
      select: { id: true, status: true, timezone: true },
    });
    if (!shop) {
      throw new ShopNotFoundError();
    }
    return shop;
  }
}
