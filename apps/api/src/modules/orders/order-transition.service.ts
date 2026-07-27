import { Injectable } from '@nestjs/common';
import { Prisma } from '@whauto/database';
import type { OrderStatus } from '@whauto/database';
import {
  canDeliverWithPayment,
  derivedFulfillmentStatus,
  isOrderTransitionAllowed,
  ORDER_CANCELLABLE_STATUSES,
  OrderAlreadyCancelledError,
  OrderCancellationNotAllowedError,
  OrderConcurrencyError,
  OrderInvalidStatusTransitionError,
  OrderNotFoundError,
  SOCKET_EVENTS,
} from '@whauto/shared';
import type { OrderStatusValue } from '@whauto/shared';

import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuditActionContext } from '../organizations/organization-audit.service';
import { OrganizationAuditService } from '../organizations/organization-audit.service';
import { OrderConversionService } from './order-conversion.service';
import { OrderStockService } from './order-stock.service';
import { ORDER_DETAIL_SELECT } from './orders.mapper';
import type { OrderDetail } from './orders.mapper';

const STATUS_TIMESTAMP_FIELD: Partial<Record<OrderStatusValue, string>> = {
  PROCESSING: 'processingAt',
  READY: 'readyAt',
  SHIPPED: 'shippedAt',
  DELIVERED: 'deliveredAt',
  CANCELLED: 'cancelledAt',
};

/**
 * SERVICE DE TRANSITION CENTRALISÉ (validé §14) : toute écriture de statut
 * d'une Order passe ici — jamais dans les contrôleurs, jamais ailleurs.
 * Chaque changement réel : updateMany conditionnel (status + version) +
 * OrderStatusHistory + audit dans la MÊME transaction.
 * Idempotence post-conversion : OrderMutation (orderId, clientMutationId).
 */
@Injectable()
export class OrderTransitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockService: OrderStockService,
    private readonly auditService: OrganizationAuditService,
    private readonly conversionService: OrderConversionService,
  ) {}

  // ------------------------------------------------------------ idempotence

  private async claimOrderMutation(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      orderId: string;
      clientMutationId: string | undefined;
      type: 'STATUS' | 'CANCEL' | 'NOTE';
      resultVersion: number;
    },
  ): Promise<void> {
    if (input.clientMutationId === undefined) {
      return;
    }
    await tx.orderMutation.create({
      data: {
        organizationId: input.organizationId,
        orderId: input.orderId,
        clientMutationId: input.clientMutationId,
        type: input.type,
        resultVersion: input.resultVersion,
      },
      select: { id: true },
    });
  }

  private isDuplicateOrderMutation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      Array.isArray(error.meta?.target) &&
      (error.meta.target as string[]).includes('clientMutationId')
    );
  }

  private async requireOrder(
    tenant: TenantContext,
    orderId: string,
  ): Promise<{ id: string }> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, organizationId: tenant.organizationId },
      select: { id: true },
    });
    if (!order) {
      throw new OrderNotFoundError();
    }
    return order;
  }

  private reloadOrder(orderId: string): Promise<OrderDetail> {
    return this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: ORDER_DETAIL_SELECT,
    });
  }

  // ------------------------------------------------------------- transition

  async changeStatus(
    tenant: TenantContext,
    orderId: string,
    input: {
      status: OrderStatusValue;
      expectedVersion: number;
      reason?: string;
      clientMutationId?: string;
    },
    context: AuditActionContext,
  ): Promise<OrderDetail> {
    await this.requireOrder(tenant, orderId);
    // L'annulation a son flux dédié (restitution) — jamais via ce endpoint.
    if (input.status === 'CANCELLED') {
      throw new OrderInvalidStatusTransitionError('*', 'CANCELLED (use the cancel endpoint)');
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
        const order = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: {
            id: true,
            organizationId: true,
            shopId: true,
            status: true,
            paymentStatus: true,
            fulfillmentStatus: true,
            fulfillmentType: true,
            paymentPreference: true,
            version: true,
          },
        });
        // Claim AVANT les vérifications de version : un replay réseau doit
        // heurter le P2002 (→ état courant renvoyé), pas le 409 de version.
        await this.claimOrderMutation(tx, {
          organizationId: order.organizationId,
          orderId,
          clientMutationId: input.clientMutationId,
          type: 'STATUS',
          resultVersion: order.version + 1,
        });
        if (order.version !== input.expectedVersion) {
          throw new OrderConcurrencyError();
        }
        if (!isOrderTransitionAllowed(order.status, input.status, order.fulfillmentType)) {
          throw new OrderInvalidStatusTransitionError(order.status, input.status);
        }
        // DELIVERED : paiement résolu OU encaissement hors ligne assumé
        // (UNPAID + CASH_ON_DELIVERY / PAY_IN_STORE — validé ajustement 18).
        if (
          input.status === 'DELIVERED' &&
          !canDeliverWithPayment(order.paymentStatus, order.paymentPreference)
        ) {
          throw new OrderInvalidStatusTransitionError(
            order.status,
            'DELIVERED (payment is not resolved)',
          );
        }

        const newFulfillment = derivedFulfillmentStatus(
          input.status,
          order.fulfillmentType,
          order.fulfillmentStatus,
        );
        const timestampField = STATUS_TIMESTAMP_FIELD[input.status];
        const now = new Date();
        const updated = await tx.order.updateMany({
          where: { id: orderId, status: order.status, version: input.expectedVersion },
          data: {
            status: input.status as OrderStatus,
            fulfillmentStatus: newFulfillment,
            version: { increment: 1 },
            ...(timestampField ? { [timestampField]: now } : {}),
          },
        });
        if (updated.count !== 1) {
          throw new OrderConcurrencyError();
        }

        await tx.orderStatusHistory.create({
          data: {
            organizationId: order.organizationId,
            shopId: order.shopId,
            orderId,
            changeType:
              newFulfillment === order.fulfillmentStatus ? 'ORDER_STATUS' : 'MULTIPLE',
            previousStatus: order.status,
            newStatus: input.status,
            previousPaymentStatus: order.paymentStatus,
            newPaymentStatus: order.paymentStatus,
            previousFulfillmentStatus: order.fulfillmentStatus,
            newFulfillmentStatus: newFulfillment,
            reason: input.reason ?? null,
            source: 'USER',
            actorUserId: tenant.userId,
          },
          select: { id: true },
        });
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'ORDER_STATUS_CHANGED',
            actorUserId: tenant.userId,
            metadata: { orderId, from: order.status, to: input.status },
            context,
          },
          tx,
        );
        return tx.order.findUniqueOrThrow({ where: { id: orderId }, select: ORDER_DETAIL_SELECT });
      });
      this.conversionService.emitOrderEvent(result, SOCKET_EVENTS.ORDER_STATUS_UPDATED);
      return result;
    } catch (error) {
      if (this.isDuplicateOrderMutation(error)) {
        return this.reloadOrder(orderId);
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ cancel

  /**
   * Annulation + restitution (validé D9 + ajustements 8, 9, 16, 17) :
   * - éligible depuis CONFIRMED/PROCESSING/READY uniquement ;
   * - la transition conditionnelle GATE la restitution (double annulation =
   *   la seconde échoue sur count=0, jamais de double restitution) ;
   * - restitution basée sur stockConsumedQuantity HISTORIQUE des OrderItems ;
   * - InventoryItem requis absent → OrderStockRestorationError, rollback total.
   */
  async cancel(
    tenant: TenantContext,
    orderId: string,
    input: { expectedVersion: number; reason?: string; clientMutationId?: string },
    context: AuditActionContext,
  ): Promise<OrderDetail> {
    await this.requireOrder(tenant, orderId);
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
        const order = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: {
            id: true,
            organizationId: true,
            shopId: true,
            status: true,
            paymentStatus: true,
            fulfillmentStatus: true,
            orderNumber: true,
            version: true,
          },
        });
        // Claim AVANT toute vérification : un replay (double clic, retry
        // réseau) renvoie l'état courant au lieu de ALREADY_CANCELLED/409.
        await this.claimOrderMutation(tx, {
          organizationId: order.organizationId,
          orderId,
          clientMutationId: input.clientMutationId,
          type: 'CANCEL',
          resultVersion: order.version + 1,
        });
        if (order.status === 'CANCELLED') {
          throw new OrderAlreadyCancelledError();
        }
        if (order.version !== input.expectedVersion) {
          throw new OrderConcurrencyError();
        }
        if (!ORDER_CANCELLABLE_STATUSES.includes(order.status)) {
          throw new OrderCancellationNotAllowedError(order.status);
        }

        const now = new Date();
        const newFulfillment =
          order.fulfillmentStatus === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : 'CANCELLED';
        // Transition conditionnelle — GATE de toute la restitution.
        const cancelled = await tx.order.updateMany({
          where: {
            id: orderId,
            status: { in: [...ORDER_CANCELLABLE_STATUSES] as OrderStatus[] },
            version: input.expectedVersion,
          },
          data: {
            status: 'CANCELLED',
            fulfillmentStatus: newFulfillment,
            cancelledAt: now,
            cancellationReason: input.reason ?? null,
            version: { increment: 1 },
          },
        });
        if (cancelled.count !== 1) {
          throw new OrderConcurrencyError();
        }

        // Restitution : quantités RÉELLEMENT consommées (historique OrderItem),
        // jamais trackInventory courant.
        const items = await tx.orderItem.findMany({
          where: { orderId },
          select: {
            id: true,
            variantId: true,
            stockConsumedQuantity: true,
            stockRestoredQuantity: true,
          },
        });
        let anyRestored = false;
        for (const item of items) {
          const toRestore = item.stockConsumedQuantity - item.stockRestoredQuantity;
          if (toRestore <= 0) {
            continue;
          }
          // variantId null (référence purgée) = InventoryItem introuvable :
          // restore lèvera OrderStockRestorationError → rollback complet.
          const counters = await this.stockService.restore(tx, {
            variantId: item.variantId ?? '__missing__',
            quantity: toRestore,
          });
          await this.stockService.recordCancellation(tx, {
            organizationId: order.organizationId,
            shopId: order.shopId,
            variantId: item.variantId as string,
            orderId,
            counters,
            restored: toRestore,
            actorUserId: tenant.userId,
          });
          await tx.orderItem.update({
            where: { id: item.id },
            data: { stockRestoredQuantity: item.stockConsumedQuantity },
            select: { id: true },
          });
          anyRestored = true;
        }

        await tx.orderStatusHistory.create({
          data: {
            organizationId: order.organizationId,
            shopId: order.shopId,
            orderId,
            changeType: 'MULTIPLE',
            previousStatus: order.status,
            newStatus: 'CANCELLED',
            previousPaymentStatus: order.paymentStatus,
            newPaymentStatus: order.paymentStatus,
            previousFulfillmentStatus: order.fulfillmentStatus,
            newFulfillmentStatus: newFulfillment,
            reason: input.reason ?? null,
            source: 'USER',
            actorUserId: tenant.userId,
          },
          select: { id: true },
        });
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'ORDER_CANCELLED',
            actorUserId: tenant.userId,
            metadata: { orderId, orderNumber: order.orderNumber, reason: input.reason ?? null },
            context,
          },
          tx,
        );
        if (anyRestored) {
          await this.auditService.record(
            {
              organizationId: tenant.organizationId,
              eventType: 'ORDER_STOCK_RESTORED',
              actorUserId: tenant.userId,
              metadata: { orderId, orderNumber: order.orderNumber },
              context,
            },
            tx,
          );
        }
        return tx.order.findUniqueOrThrow({ where: { id: orderId }, select: ORDER_DETAIL_SELECT });
      });
      this.conversionService.emitOrderEvent(result, SOCKET_EVENTS.ORDER_CANCELLED);
      return result;
    } catch (error) {
      if (this.isDuplicateOrderMutation(error)) {
        return this.reloadOrder(orderId);
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------- notes

  async addNote(
    tenant: TenantContext,
    orderId: string,
    input: { content: string; clientMutationId?: string },
    context: AuditActionContext,
  ): Promise<OrderDetail> {
    await this.requireOrder(tenant, orderId);
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const order = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { id: true, organizationId: true, shopId: true, version: true },
        });
        await this.claimOrderMutation(tx, {
          organizationId: order.organizationId,
          orderId,
          clientMutationId: input.clientMutationId,
          type: 'NOTE',
          resultVersion: order.version,
        });
        await tx.orderNote.create({
          data: {
            organizationId: order.organizationId,
            shopId: order.shopId,
            orderId,
            authorUserId: tenant.userId,
            content: input.content,
          },
          select: { id: true },
        });
        await this.auditService.record(
          {
            organizationId: tenant.organizationId,
            eventType: 'ORDER_NOTE_ADDED',
            actorUserId: tenant.userId,
            metadata: { orderId },
            context,
          },
          tx,
        );
        return tx.order.findUniqueOrThrow({ where: { id: orderId }, select: ORDER_DETAIL_SELECT });
      });
      this.conversionService.emitOrderEvent(result, SOCKET_EVENTS.ORDER_NOTE_CREATED);
      return result;
    } catch (error) {
      if (this.isDuplicateOrderMutation(error)) {
        return this.reloadOrder(orderId);
      }
      throw error;
    }
  }
}
