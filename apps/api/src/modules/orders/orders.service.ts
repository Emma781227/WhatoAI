import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import type { OrderFulfillmentStatus, OrderPaymentStatus, OrderStatus } from '@whauto/database';
import { buildOrderSummaryText, isPaymentToCollect, OrderNotFoundError } from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ORDER_DETAIL_SELECT,
  ORDER_HISTORY_SELECT,
  ORDER_LIST_SELECT,
  ORDER_NOTE_SELECT,
} from './orders.mapper';
import type { OrderDetail, OrderHistoryRow, OrderListRow, OrderNoteRow } from './orders.mapper';

export interface ListOrdersFilters {
  page: number;
  limit: number;
  search?: string;
  shopId?: string;
  contactId?: string;
  conversationId?: string;
  status?: OrderStatus;
  paymentStatus?: OrderPaymentStatus;
  fulfillmentStatus?: OrderFulfillmentStatus;
  fulfillmentType?: 'DELIVERY' | 'PICKUP';
  createdFrom?: Date;
  createdTo?: Date;
  minTotalMinor?: number;
  maxTotalMinor?: number;
  sortBy: 'createdAt' | 'updatedAt' | 'totalMinor';
  sortDir: 'asc' | 'desc';
}

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /** TOUS les filtres dans le where PostgreSQL — jamais de filtrage de page en mémoire. */
  async list(
    tenant: TenantContext,
    filters: ListOrdersFilters,
  ): Promise<{ items: OrderListRow[]; total: number; page: number; limit: number }> {
    const where: Prisma.OrderWhereInput = {
      organizationId: tenant.organizationId,
      ...(filters.shopId ? { shopId: filters.shopId } : {}),
      ...(filters.contactId ? { contactId: filters.contactId } : {}),
      ...(filters.conversationId ? { conversationId: filters.conversationId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.paymentStatus ? { paymentStatus: filters.paymentStatus } : {}),
      ...(filters.fulfillmentStatus ? { fulfillmentStatus: filters.fulfillmentStatus } : {}),
      ...(filters.fulfillmentType ? { fulfillmentType: filters.fulfillmentType } : {}),
      ...(filters.createdFrom || filters.createdTo
        ? {
            createdAt: {
              ...(filters.createdFrom ? { gte: filters.createdFrom } : {}),
              ...(filters.createdTo ? { lte: filters.createdTo } : {}),
            },
          }
        : {}),
      ...(filters.minTotalMinor !== undefined || filters.maxTotalMinor !== undefined
        ? {
            totalMinor: {
              ...(filters.minTotalMinor !== undefined ? { gte: filters.minTotalMinor } : {}),
              ...(filters.maxTotalMinor !== undefined ? { lte: filters.maxTotalMinor } : {}),
            },
          }
        : {}),
      ...(filters.search
        ? {
            OR: [
              { orderNumber: { contains: filters.search, mode: 'insensitive' as const } },
              { customerName: { contains: filters.search, mode: 'insensitive' as const } },
              { customerPhone: { contains: filters.search } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        select: ORDER_LIST_SELECT,
        orderBy: { [filters.sortBy]: filters.sortDir },
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items, total, page: filters.page, limit: filters.limit };
  }

  async getDetail(tenant: TenantContext, orderId: string): Promise<OrderDetail> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId: tenant.organizationId },
      select: ORDER_DETAIL_SELECT,
    });
    if (!order) {
      throw new OrderNotFoundError();
    }
    return order;
  }

  async listForConversation(
    tenant: TenantContext,
    conversationId: string,
  ): Promise<OrderListRow[]> {
    return this.prisma.order.findMany({
      where: { conversationId, organizationId: tenant.organizationId },
      select: ORDER_LIST_SELECT,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  async getHistory(tenant: TenantContext, orderId: string): Promise<OrderHistoryRow[]> {
    await this.getDetail(tenant, orderId);
    return this.prisma.orderStatusHistory.findMany({
      where: { orderId },
      select: ORDER_HISTORY_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  async getNotes(tenant: TenantContext, orderId: string): Promise<OrderNoteRow[]> {
    await this.getDetail(tenant, orderId);
    return this.prisma.orderNote.findMany({
      where: { orderId },
      select: ORDER_NOTE_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Texte serveur — l'agent l'insère dans le composer, jamais d'envoi auto. */
  async summaryText(
    tenant: TenantContext,
    orderId: string,
  ): Promise<{ text: string; orderVersion: number; orderNumber: string; warnings: string[] }> {
    const order = await this.getDetail(tenant, orderId);
    const warnings: string[] = [];
    if (isPaymentToCollect(order.paymentStatus, order.paymentPreference)) {
      warnings.push('PAYMENT_TO_COLLECT');
    }
    if (order.items.some((item) => item.backorderedQuantity > 0)) {
      warnings.push('BACKORDERED_ITEMS');
    }
    const text = buildOrderSummaryText({
      orderNumber: order.orderNumber,
      status: order.status,
      lines: order.items.map((item) => ({
        productName: item.productName,
        variantName: item.variantName,
        quantity: item.quantity,
        lineSubtotalMinor: item.lineSubtotalMinor,
      })),
      currency: order.currency,
      totalMinor: order.totalMinor,
      deliveryFeeMinor: order.deliveryFeeMinor,
      fulfillmentType: order.fulfillmentType,
      city: order.city,
      landmark: order.landmark,
      paymentPreference: order.paymentPreference,
    });
    return { text, orderVersion: order.version, orderNumber: order.orderNumber, warnings };
  }
}
