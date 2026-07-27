import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  OrderFulfillmentStatus,
  OrderPaymentStatus,
  OrderStatus,
  type OrderStatusChangeType,
  type OrderStatusSource,
} from '@whauto/database';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import type { OrderDetail, OrderHistoryRow, OrderListRow, OrderNoteRow } from '../orders.mapper';

// ---------------------------------------------------------------- entrées
// AUCUN total, article, prix, stock ou adresse n'est accepté du frontend :
// whitelist stricte (forbidNonWhitelisted global) — le snapshot serveur est
// l'unique source commerciale.

export class ConvertToOrderDto {
  @ApiPropertyOptional({ description: 'Idempotence : rejouer renvoie la même Order.' })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  clientMutationId?: string;

  @ApiPropertyOptional({ description: 'Version attendue du Cart (409 si périmée).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedCartVersion?: number;

  @ApiPropertyOptional({ description: 'Version attendue du CheckoutSession (409 si périmée).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedCheckoutVersion?: number;
}

const USER_SETTABLE_STATUSES = ['PROCESSING', 'READY', 'SHIPPED', 'DELIVERED'] as const;

export class ChangeOrderStatusDto {
  @ApiProperty({ enum: USER_SETTABLE_STATUSES, description: 'CANCELLED passe par /cancel.' })
  @IsIn([...USER_SETTABLE_STATUSES])
  status!: (typeof USER_SETTABLE_STATUSES)[number];

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(8, 64)
  clientMutationId?: string;
}

export class CancelOrderDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(8, 64)
  clientMutationId?: string;
}

export class AddOrderNoteDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(8, 64)
  clientMutationId?: string;
}

export class ListOrdersQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'orderNumber, nom ou téléphone client.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shopId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contactId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ enum: OrderPaymentStatus })
  @IsOptional()
  @IsEnum(OrderPaymentStatus)
  paymentStatus?: OrderPaymentStatus;

  @ApiPropertyOptional({ enum: OrderFulfillmentStatus })
  @IsOptional()
  @IsEnum(OrderFulfillmentStatus)
  fulfillmentStatus?: OrderFulfillmentStatus;

  @ApiPropertyOptional({ enum: ['DELIVERY', 'PICKUP'] })
  @IsOptional()
  @IsIn(['DELIVERY', 'PICKUP'])
  fulfillmentType?: 'DELIVERY' | 'PICKUP';

  @ApiPropertyOptional({ description: 'ISO 8601.' })
  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @ApiPropertyOptional({ description: 'ISO 8601.' })
  @IsOptional()
  @IsISO8601()
  createdTo?: string;

  @ApiPropertyOptional({ description: 'Unité mineure.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minTotalMinor?: number;

  @ApiPropertyOptional({ description: 'Unité mineure.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxTotalMinor?: number;

  @ApiPropertyOptional({ enum: ['createdAt', 'updatedAt', 'totalMinor'], default: 'createdAt' })
  @IsOptional()
  @IsIn(['createdAt', 'updatedAt', 'totalMinor'])
  sortBy?: 'createdAt' | 'updatedAt' | 'totalMinor';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';
}

// ---------------------------------------------------------------- sorties

export class OrderItemResponseDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional({ nullable: true, description: 'Référence historique — le snapshot fait foi.' })
  productId!: string | null;
  @ApiPropertyOptional({ nullable: true }) variantId!: string | null;
  @ApiProperty() productName!: string;
  @ApiPropertyOptional({ nullable: true }) variantName!: string | null;
  @ApiProperty() sku!: string;
  @ApiPropertyOptional({ nullable: true }) imageUrl!: string | null;
  @ApiPropertyOptional({ nullable: true }) optionValuesSnapshot!: unknown;
  @ApiProperty() productTypeSnapshot!: string;
  @ApiProperty() trackInventorySnapshot!: boolean;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitPriceMinor!: number;
  @ApiPropertyOptional({ nullable: true }) compareAtPriceMinor!: number | null;
  @ApiProperty() lineSubtotalMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() stockConsumedQuantity!: number;
  @ApiProperty() backorderedQuantity!: number;
  @ApiProperty() stockRestoredQuantity!: number;
}

export class OrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orderNumber!: string;
  @ApiProperty() shopId!: string;
  @ApiProperty() conversationId!: string;
  @ApiProperty() contactId!: string;
  @ApiProperty({ enum: OrderStatus }) status!: OrderStatus;
  @ApiProperty({ enum: OrderPaymentStatus }) paymentStatus!: OrderPaymentStatus;
  @ApiProperty({ enum: OrderFulfillmentStatus }) fulfillmentStatus!: OrderFulfillmentStatus;
  @ApiProperty() fulfillmentType!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() subtotalMinor!: number;
  @ApiProperty() discountMinor!: number;
  @ApiProperty() deliveryFeeMinor!: number;
  @ApiProperty() totalMinor!: number;
  @ApiProperty() itemCount!: number;
  @ApiProperty() customerName!: string;
  @ApiProperty() customerPhone!: string;
  @ApiPropertyOptional({ nullable: true }) customerEmail!: string | null;
  @ApiPropertyOptional({ nullable: true }) addressLine1!: string | null;
  @ApiPropertyOptional({ nullable: true }) addressLine2!: string | null;
  @ApiPropertyOptional({ nullable: true }) city!: string | null;
  @ApiPropertyOptional({ nullable: true }) region!: string | null;
  @ApiPropertyOptional({ nullable: true }) postalCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) countryCode!: string | null;
  @ApiPropertyOptional({ nullable: true }) landmark!: string | null;
  @ApiPropertyOptional({ nullable: true }) deliveryInstructions!: string | null;
  @ApiProperty() paymentPreference!: string;
  @ApiPropertyOptional({ nullable: true }) cancellationReason!: string | null;
  @ApiProperty() confirmedAt!: Date;
  @ApiPropertyOptional({ nullable: true }) processingAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) readyAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) shippedAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) deliveredAt!: Date | null;
  @ApiPropertyOptional({ nullable: true }) cancelledAt!: Date | null;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ type: [OrderItemResponseDto] }) items!: OrderItemResponseDto[];
  @ApiProperty() contact!: { id: string; displayName: string | null; whatsappPhone: string };
  @ApiProperty() shop!: { id: string; name: string };

  static fromOrder(order: OrderDetail): OrderResponseDto {
    const dto = new OrderResponseDto();
    Object.assign(dto, {
      ...order,
      // Le snapshot brut ne sort jamais : items est déjà le DTO structuré.
      items: order.items,
    });
    return dto;
  }
}

export class OrderListItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orderNumber!: string;
  @ApiProperty() shopId!: string;
  @ApiProperty() conversationId!: string;
  @ApiProperty({ enum: OrderStatus }) status!: OrderStatus;
  @ApiProperty({ enum: OrderPaymentStatus }) paymentStatus!: OrderPaymentStatus;
  @ApiProperty({ enum: OrderFulfillmentStatus }) fulfillmentStatus!: OrderFulfillmentStatus;
  @ApiProperty() fulfillmentType!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() totalMinor!: number;
  @ApiProperty() itemCount!: number;
  @ApiProperty() customerName!: string;
  @ApiProperty() customerPhone!: string;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty() shopName!: string;

  static fromRow(row: OrderListRow): OrderListItemResponseDto {
    const dto = new OrderListItemResponseDto();
    const { shop, ...rest } = row;
    Object.assign(dto, rest, { shopName: shop.name });
    return dto;
  }
}

export class OrderListResponseDto {
  @ApiProperty({ type: [OrderListItemResponseDto] }) items!: OrderListItemResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class OrderHistoryEntryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() changeType!: OrderStatusChangeType;
  @ApiPropertyOptional({ nullable: true }) previousStatus!: OrderStatus | null;
  @ApiProperty() newStatus!: OrderStatus;
  @ApiPropertyOptional({ nullable: true }) previousPaymentStatus!: OrderPaymentStatus | null;
  @ApiProperty() newPaymentStatus!: OrderPaymentStatus;
  @ApiPropertyOptional({ nullable: true })
  previousFulfillmentStatus!: OrderFulfillmentStatus | null;
  @ApiProperty() newFulfillmentStatus!: OrderFulfillmentStatus;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiProperty() source!: OrderStatusSource;
  @ApiPropertyOptional({ nullable: true }) actorName!: string | null;
  @ApiProperty() createdAt!: Date;

  static fromRow(row: OrderHistoryRow): OrderHistoryEntryResponseDto {
    const dto = new OrderHistoryEntryResponseDto();
    const { actor, actorUserId, ...rest } = row;
    void actorUserId;
    Object.assign(dto, rest, {
      actorName: actor ? `${actor.firstName} ${actor.lastName}` : null,
    });
    return dto;
  }
}

export class OrderNoteResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() content!: string;
  @ApiPropertyOptional({ nullable: true }) authorName!: string | null;
  @ApiProperty() createdAt!: Date;

  static fromRow(row: OrderNoteRow): OrderNoteResponseDto {
    const dto = new OrderNoteResponseDto();
    const { author, authorUserId, ...rest } = row;
    void authorUserId;
    Object.assign(dto, rest, {
      authorName: author ? `${author.firstName} ${author.lastName}` : null,
    });
    return dto;
  }
}

export class OrderSummaryResponseDto {
  @ApiProperty() text!: string;
  @ApiProperty() orderVersion!: number;
  @ApiProperty() orderNumber!: string;
  @ApiProperty({ type: [String] }) warnings!: string[];
}
