-- CreateEnum
CREATE TYPE "CartStatus" AS ENUM ('ACTIVE', 'CHECKOUT_STARTED', 'CONVERTED', 'ABANDONED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED', 'CONSUMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CheckoutStatus" AS ENUM ('COLLECTING_INFORMATION', 'READY_FOR_CONFIRMATION', 'CONFIRMED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "FulfillmentType" AS ENUM ('DELIVERY', 'PICKUP');

-- CreateEnum
CREATE TYPE "PaymentPreference" AS ENUM ('CASH_ON_DELIVERY', 'MOBILE_MONEY', 'CARD', 'PAY_IN_STORE', 'UNDECIDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CART_CREATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CART_ITEM_ADDED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CART_ITEM_UPDATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CART_ITEM_REMOVED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CART_CLEARED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CART_ABANDONED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CART_EXPIRED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CHECKOUT_STARTED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CHECKOUT_UPDATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CHECKOUT_CONFIRMED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'STOCK_RESERVED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'STOCK_RELEASED';

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "quantityReservedAfter" INTEGER,
ADD COLUMN     "quantityReservedBefore" INTEGER;

-- CreateTable
CREATE TABLE "carts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "status" "CartStatus" NOT NULL DEFAULT 'ACTIVE',
    "currency" TEXT NOT NULL,
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "deliveryFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "checkoutStartedAt" TIMESTAMP(3),
    "convertedAt" TIMESTAMP(3),
    "abandonedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "compareAtPriceMinor" INTEGER,
    "lineSubtotalMinor" INTEGER NOT NULL,
    "productNameSnapshot" TEXT NOT NULL,
    "variantNameSnapshot" TEXT,
    "skuSnapshot" TEXT NOT NULL,
    "imageUrlSnapshot" TEXT,
    "optionValuesSnapshot" JSONB,
    "availabilityStatus" TEXT NOT NULL DEFAULT 'VALID',
    "currentPriceMinor" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "cartItemId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "renewedCount" INTEGER NOT NULL DEFAULT 0,
    "lastRenewedAt" TIMESTAMP(3),
    "maxExpiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "status" "CheckoutStatus" NOT NULL DEFAULT 'COLLECTING_INFORMATION',
    "customerName" TEXT,
    "customerPhone" TEXT NOT NULL,
    "customerEmail" TEXT,
    "fulfillmentType" "FulfillmentType",
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "countryCode" TEXT,
    "landmark" TEXT,
    "deliveryInstructions" TEXT,
    "paymentPreference" "PaymentPreference" NOT NULL DEFAULT 'UNDECIDED',
    "confirmationSnapshot" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_mutations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "clientMutationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_mutations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "carts_organizationId_shopId_status_idx" ON "carts"("organizationId", "shopId", "status");

-- CreateIndex
CREATE INDEX "carts_status_expiresAt_idx" ON "carts"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "carts_id_shopId_key" ON "carts"("id", "shopId");

-- CreateIndex
CREATE INDEX "cart_items_variantId_idx" ON "cart_items"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_cartId_variantId_key" ON "cart_items"("cartId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_id_cartId_key" ON "cart_items"("id", "cartId");

-- CreateIndex
CREATE INDEX "stock_reservations_status_expiresAt_idx" ON "stock_reservations"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "stock_reservations_variantId_status_idx" ON "stock_reservations"("variantId", "status");

-- CreateIndex
CREATE INDEX "stock_reservations_cartId_idx" ON "stock_reservations"("cartId");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_sessions_cartId_key" ON "checkout_sessions"("cartId");

-- CreateIndex
CREATE INDEX "checkout_sessions_organizationId_shopId_status_idx" ON "checkout_sessions"("organizationId", "shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_sessions_cartId_shopId_key" ON "checkout_sessions"("cartId", "shopId");

-- CreateIndex
CREATE INDEX "cart_mutations_createdAt_idx" ON "cart_mutations"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "cart_mutations_conversationId_clientMutationId_key" ON "cart_mutations"("conversationId", "clientMutationId");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_id_shopId_key" ON "contacts"("id", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_id_shopId_key" ON "conversations"("id", "shopId");

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_contactId_shopId_fkey" FOREIGN KEY ("contactId", "shopId") REFERENCES "contacts"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_conversationId_shopId_fkey" FOREIGN KEY ("conversationId", "shopId") REFERENCES "conversations"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cartId_shopId_fkey" FOREIGN KEY ("cartId", "shopId") REFERENCES "carts"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_productId_shopId_fkey" FOREIGN KEY ("productId", "shopId") REFERENCES "products"("id", "shopId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "product_variants"("id", "productId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_cartId_shopId_fkey" FOREIGN KEY ("cartId", "shopId") REFERENCES "carts"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_cartItemId_cartId_fkey" FOREIGN KEY ("cartItemId", "cartId") REFERENCES "cart_items"("id", "cartId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_variantId_shopId_fkey" FOREIGN KEY ("variantId", "shopId") REFERENCES "product_variants"("id", "shopId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_cartId_shopId_fkey" FOREIGN KEY ("cartId", "shopId") REFERENCES "carts"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_mutations" ADD CONSTRAINT "cart_mutations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- Contraintes ajoutées à la main (inexprimables dans schema.prisma).
-- ATTENTION : elles n'existent QUE dans ce fichier de migration. `prisma db
-- push` ne les recrée pas — le seed échoue si elles manquent (voir CLAUDE.md).
-- ============================================================================

-- UN SEUL panier ouvert par Conversation, même sous création concurrente
-- (deux premiers ajouts simultanés → P2002, le second réutilise le panier).
CREATE UNIQUE INDEX "carts_one_open_per_conversation"
ON "carts" ("conversationId")
WHERE "status" IN ('ACTIVE', 'CHECKOUT_STARTED');

-- Une seule réservation ACTIVE par ligne de panier. Les lignes historiques
-- (RELEASED/EXPIRED/CONSUMED/CANCELLED) sont conservées — un cycle = une
-- ligne, jamais réutilisée (décision validée).
CREATE UNIQUE INDEX "stock_reservations_one_active_per_cart_item"
ON "stock_reservations" ("cartItemId")
WHERE "status" = 'ACTIVE';

-- Défense en profondeur : totaux et quantités jamais négatifs, quantité de
-- ligne et de réservation strictement positives.
ALTER TABLE "carts"
  ADD CONSTRAINT "carts_subtotal_non_negative" CHECK ("subtotalMinor" >= 0),
  ADD CONSTRAINT "carts_total_non_negative" CHECK ("totalMinor" >= 0),
  ADD CONSTRAINT "carts_item_count_non_negative" CHECK ("itemCount" >= 0);

ALTER TABLE "cart_items"
  ADD CONSTRAINT "cart_items_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "cart_items_unit_price_non_negative" CHECK ("unitPriceMinor" >= 0),
  ADD CONSTRAINT "cart_items_line_subtotal_coherent"
    CHECK ("lineSubtotalMinor" = "unitPriceMinor" * "quantity");

ALTER TABLE "stock_reservations"
  ADD CONSTRAINT "stock_reservations_quantity_positive" CHECK ("quantity" > 0);

-- Cohérence des colonnes InventoryMovement selon le type (décision validée) :
-- RESERVATION/RELEASE ne touchent QUE quantityReserved — onHand inchangé
-- (delta = 0, before = after) et colonnes réservées obligatoirement remplies
-- et cohérentes entre elles.
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_reservation_semantics" CHECK (
    "type" NOT IN ('RESERVATION', 'RELEASE')
    OR (
      "quantityDelta" = 0
      AND "quantityBefore" = "quantityAfter"
      AND "quantityReservedBefore" IS NOT NULL
      AND "quantityReservedAfter" IS NOT NULL
      AND "quantityReservedBefore" <> "quantityReservedAfter"
    )
  ),
  ADD CONSTRAINT "inventory_movements_reserved_columns_paired" CHECK (
    ("quantityReservedBefore" IS NULL) = ("quantityReservedAfter" IS NULL)
  );
