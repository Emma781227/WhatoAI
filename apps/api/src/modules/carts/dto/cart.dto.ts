import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CartStatus,
  CheckoutStatus,
  FulfillmentType,
  PaymentPreference,
  StockReservationStatus,
} from '@whauto/database';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import type { CartDetail, CartItemRow, CheckoutRow } from '../carts.mapper';
import { earliestReservationExpiry } from '../carts.mapper';

// ------------------------------------------------------------------- inputs
// AUCUN total/subtotal accepté du body (whitelist stricte + forbidNonWhitelisted).

export class AddCartItemDto {
  @ApiProperty()
  @IsString()
  variantId!: string;

  @ApiProperty({ minimum: 1, maximum: 999 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  quantity!: number;

  @ApiPropertyOptional({ description: 'Verrou optimiste (version du Cart).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion?: number;

  @ApiPropertyOptional({ description: 'Idempotence des retries réseau.' })
  @IsOptional()
  @IsString()
  @Length(8, 64)
  clientMutationId?: string;
}

export class UpdateCartItemDto {
  @ApiProperty({ minimum: 1, maximum: 999 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  quantity!: number;

  @ApiProperty({ description: 'Version du Cart lue — 409 CART_CONCURRENCY si périmée.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(8, 64)
  clientMutationId?: string;
}

export class CartVersionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}

export class CartMutationDto extends CartVersionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(8, 64)
  clientMutationId?: string;
}

export class UpdateCheckoutDto {
  @ApiProperty({ description: 'Version de la CheckoutSession lue (deux onglets → 409).' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(100)
  customerName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  customerPhone?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(200)
  customerEmail?: string | null;

  @ApiPropertyOptional({ enum: FulfillmentType })
  @IsOptional()
  @IsEnum(FulfillmentType)
  fulfillmentType?: FulfillmentType;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(300)
  addressLine1?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(300)
  addressLine2?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(100)
  region?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Jamais obligatoire (Cameroun).' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20)
  postalCode?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(2)
  countryCode?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Repère (alternative à l’adresse).' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(300)
  landmark?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(1000)
  deliveryInstructions?: string | null;

  @ApiPropertyOptional({ enum: PaymentPreference })
  @IsOptional()
  @IsEnum(PaymentPreference)
  paymentPreference?: PaymentPreference;
}

export class ConfirmCheckoutDto {
  @ApiProperty({ description: 'Version de la CheckoutSession lue.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(8, 64)
  clientMutationId?: string;
}

// ------------------------------------------------------------------ réponses

export class ReservationSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  quantity!: number;

  @ApiProperty({ enum: StockReservationStatus })
  status!: StockReservationStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;
}

export class CartItemResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  productId!: string;

  @ApiProperty()
  variantId!: string;

  @ApiProperty()
  quantity!: number;

  @ApiProperty()
  unitPriceMinor!: number;

  @ApiPropertyOptional({ nullable: true })
  compareAtPriceMinor!: number | null;

  @ApiProperty()
  lineSubtotalMinor!: number;

  @ApiProperty()
  productName!: string;

  @ApiPropertyOptional({ nullable: true })
  variantName!: string | null;

  @ApiProperty()
  sku!: string;

  @ApiPropertyOptional({ nullable: true })
  imageUrl!: string | null;

  @ApiPropertyOptional({ nullable: true })
  optionValues!: unknown;

  @ApiProperty({
    enum: [
      'VALID',
      'PRICE_CHANGED',
      'OUT_OF_STOCK',
      'QUANTITY_REDUCED_REQUIRED',
      'PRODUCT_UNAVAILABLE',
      'VARIANT_UNAVAILABLE',
    ],
  })
  availabilityStatus!: string;

  @ApiPropertyOptional({ nullable: true })
  currentPriceMinor!: number | null;

  @ApiProperty()
  version!: number;

  /** Résumé de la réservation ACTIVE de la ligne (visible tous rôles — validé). */
  @ApiPropertyOptional({ type: ReservationSummaryDto, nullable: true })
  reservation!: ReservationSummaryDto | null;

  static fromRow(item: CartItemRow): CartItemResponseDto {
    return Object.assign(new CartItemResponseDto(), {
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      compareAtPriceMinor: item.compareAtPriceMinor,
      lineSubtotalMinor: item.lineSubtotalMinor,
      productName: item.productNameSnapshot,
      variantName: item.variantNameSnapshot,
      sku: item.skuSnapshot,
      imageUrl: item.imageUrlSnapshot,
      optionValues: item.optionValuesSnapshot,
      availabilityStatus: item.availabilityStatus,
      currentPriceMinor: item.currentPriceMinor,
      version: item.version,
      reservation: item.reservations[0]
        ? {
            id: item.reservations[0].id,
            quantity: item.reservations[0].quantity,
            status: item.reservations[0].status,
            expiresAt: item.reservations[0].expiresAt,
          }
        : null,
    });
  }
}

export class CheckoutResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: CheckoutStatus })
  status!: CheckoutStatus;

  @ApiPropertyOptional({ nullable: true })
  customerName!: string | null;

  @ApiProperty()
  customerPhone!: string;

  @ApiPropertyOptional({ nullable: true })
  customerEmail!: string | null;

  @ApiPropertyOptional({ enum: FulfillmentType, nullable: true })
  fulfillmentType!: FulfillmentType | null;

  @ApiPropertyOptional({ nullable: true })
  addressLine1!: string | null;

  @ApiPropertyOptional({ nullable: true })
  addressLine2!: string | null;

  @ApiPropertyOptional({ nullable: true })
  city!: string | null;

  @ApiPropertyOptional({ nullable: true })
  region!: string | null;

  @ApiPropertyOptional({ nullable: true })
  postalCode!: string | null;

  @ApiPropertyOptional({ nullable: true })
  countryCode!: string | null;

  @ApiPropertyOptional({ nullable: true })
  landmark!: string | null;

  @ApiPropertyOptional({ nullable: true })
  deliveryInstructions!: string | null;

  @ApiProperty({ enum: PaymentPreference })
  paymentPreference!: PaymentPreference;

  @ApiPropertyOptional({ nullable: true, description: 'Snapshot immuable (CONFIRMED uniquement).' })
  confirmationSnapshot!: unknown;

  @ApiProperty()
  version!: number;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  completedAt!: Date | null;

  static fromRow(checkout: CheckoutRow): CheckoutResponseDto {
    return Object.assign(new CheckoutResponseDto(), checkout);
  }
}

export class CartResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  shopId!: string;

  @ApiProperty()
  contactId!: string;

  @ApiProperty()
  conversationId!: string;

  @ApiProperty({ enum: CartStatus })
  status!: CartStatus;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  subtotalMinor!: number;

  @ApiProperty()
  discountMinor!: number;

  @ApiProperty()
  deliveryFeeMinor!: number;

  @ApiProperty()
  totalMinor!: number;

  @ApiProperty()
  itemCount!: number;

  @ApiProperty({ description: 'Verrou optimiste — à renvoyer en expectedVersion.' })
  version!: number;

  @ApiProperty({ type: [CartItemResponseDto] })
  items!: CartItemResponseDto[];

  @ApiPropertyOptional({ type: CheckoutResponseDto, nullable: true })
  checkout!: CheckoutResponseDto | null;

  /** Plus proche expiration des réservations ACTIVE (résumé visible tous rôles). */
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  reservationExpiresAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  static fromCart(cart: CartDetail): CartResponseDto {
    return Object.assign(new CartResponseDto(), {
      id: cart.id,
      organizationId: cart.organizationId,
      shopId: cart.shopId,
      contactId: cart.contactId,
      conversationId: cart.conversationId,
      status: cart.status,
      currency: cart.currency,
      subtotalMinor: cart.subtotalMinor,
      discountMinor: cart.discountMinor,
      deliveryFeeMinor: cart.deliveryFeeMinor,
      totalMinor: cart.totalMinor,
      itemCount: cart.itemCount,
      version: cart.version,
      items: cart.items.map((item) => CartItemResponseDto.fromRow(item)),
      checkout: cart.checkout ? CheckoutResponseDto.fromRow(cart.checkout) : null,
      reservationExpiresAt: earliestReservationExpiry(cart),
      createdAt: cart.createdAt,
      updatedAt: cart.updatedAt,
    });
  }
}

export class CartSummaryResponseDto {
  @ApiProperty()
  text!: string;

  @ApiProperty()
  cartVersion!: number;

  @ApiProperty()
  isRevalidated!: boolean;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  reservationExpiresAt!: Date | null;

  @ApiProperty({ description: 'Lignes non-VALID détectées lors de la revalidation.' })
  warnings!: Array<{ cartItemId: string; status: string }>;
}

export class RevalidationResponseDto {
  @ApiProperty({ type: CartResponseDto })
  cart!: CartResponseDto;

  @ApiProperty()
  lines!: Array<{ cartItemId: string; status: string; currentPriceMinor: number; maxQuantity?: number }>;
}
