-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CONFIRMED', 'PROCESSING', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderPaymentStatus" AS ENUM ('UNPAID', 'PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "OrderFulfillmentStatus" AS ENUM ('PENDING', 'PREPARING', 'READY_FOR_PICKUP', 'READY_FOR_SHIPMENT', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "OrderStatusSource" AS ENUM ('USER', 'SYSTEM', 'PAYMENT', 'DELIVERY', 'AUTOMATION');

-- CreateEnum
CREATE TYPE "OrderStatusChangeType" AS ENUM ('ORDER_STATUS', 'PAYMENT_STATUS', 'FULFILLMENT_STATUS', 'MULTIPLE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'ORDER_CREATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'ORDER_STATUS_CHANGED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'ORDER_CANCELLED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'ORDER_NOTE_ADDED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'ORDER_STOCK_CONSUMED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'ORDER_STOCK_RESTORED';

-- AlterTable
ALTER TABLE "shops" ADD COLUMN     "orderNumberPrefix" TEXT;

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "checkoutSessionId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'CONFIRMED',
    "paymentStatus" "OrderPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "fulfillmentStatus" "OrderFulfillmentStatus" NOT NULL DEFAULT 'PENDING',
    "fulfillmentType" "FulfillmentType" NOT NULL,
    "currency" TEXT NOT NULL,
    "subtotalMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "deliveryFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerEmail" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "countryCode" TEXT,
    "landmark" TEXT,
    "deliveryInstructions" TEXT,
    "paymentPreference" "PaymentPreference" NOT NULL,
    "customerNote" TEXT,
    "cancellationReason" TEXT,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "processingAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "productName" TEXT NOT NULL,
    "variantName" TEXT,
    "sku" TEXT NOT NULL,
    "imageUrl" TEXT,
    "optionValuesSnapshot" JSONB,
    "productTypeSnapshot" "ProductType" NOT NULL,
    "trackInventorySnapshot" BOOLEAN NOT NULL,
    "allowBackorderSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "compareAtPriceMinor" INTEGER,
    "lineSubtotalMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "stockConsumedQuantity" INTEGER NOT NULL DEFAULT 0,
    "backorderedQuantity" INTEGER NOT NULL DEFAULT 0,
    "stockRestoredQuantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_sequences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "changeType" "OrderStatusChangeType" NOT NULL,
    "previousStatus" "OrderStatus",
    "newStatus" "OrderStatus" NOT NULL,
    "previousPaymentStatus" "OrderPaymentStatus",
    "newPaymentStatus" "OrderPaymentStatus" NOT NULL,
    "previousFulfillmentStatus" "OrderFulfillmentStatus",
    "newFulfillmentStatus" "OrderFulfillmentStatus" NOT NULL,
    "reason" TEXT,
    "source" "OrderStatusSource" NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_notes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_mutations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "clientMutationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "resultVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_mutations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_cartId_key" ON "orders"("cartId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_checkoutSessionId_key" ON "orders"("checkoutSessionId");

-- CreateIndex
CREATE INDEX "orders_organizationId_shopId_status_idx" ON "orders"("organizationId", "shopId", "status");

-- CreateIndex
CREATE INDEX "orders_organizationId_createdAt_idx" ON "orders"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "orders_organizationId_totalMinor_idx" ON "orders"("organizationId", "totalMinor");

-- CreateIndex
CREATE INDEX "orders_contactId_idx" ON "orders"("contactId");

-- CreateIndex
CREATE INDEX "orders_conversationId_idx" ON "orders"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_organizationId_orderNumber_key" ON "orders"("organizationId", "orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "orders_id_shopId_key" ON "orders"("id", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_cartId_shopId_key" ON "orders"("cartId", "shopId");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_variantId_idx" ON "order_items"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "order_sequences_shopId_year_key" ON "order_sequences"("shopId", "year");

-- CreateIndex
CREATE INDEX "order_status_history_orderId_createdAt_idx" ON "order_status_history"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "order_notes_orderId_createdAt_idx" ON "order_notes"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "order_mutations_createdAt_idx" ON "order_mutations"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "order_mutations_orderId_clientMutationId_key" ON "order_mutations"("orderId", "clientMutationId");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_contactId_shopId_fkey" FOREIGN KEY ("contactId", "shopId") REFERENCES "contacts"("id", "shopId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_conversationId_shopId_fkey" FOREIGN KEY ("conversationId", "shopId") REFERENCES "conversations"("id", "shopId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_cartId_shopId_fkey" FOREIGN KEY ("cartId", "shopId") REFERENCES "carts"("id", "shopId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkoutSessionId_fkey" FOREIGN KEY ("checkoutSessionId") REFERENCES "checkout_sessions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_shopId_fkey" FOREIGN KEY ("orderId", "shopId") REFERENCES "orders"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_sequences" ADD CONSTRAINT "order_sequences_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_sequences" ADD CONSTRAINT "order_sequences_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_orderId_shopId_fkey" FOREIGN KEY ("orderId", "shopId") REFERENCES "orders"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_notes" ADD CONSTRAINT "order_notes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_notes" ADD CONSTRAINT "order_notes_orderId_shopId_fkey" FOREIGN KEY ("orderId", "shopId") REFERENCES "orders"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_notes" ADD CONSTRAINT "order_notes_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_mutations" ADD CONSTRAINT "order_mutations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_mutations" ADD CONSTRAINT "order_mutations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- Section MANUELLE (inexprimable en schema.prisma) — ne pas régénérer par diff
-- ============================================================================

-- Préfixe de numéro de commande : unicité INSENSIBLE À LA CASSE par
-- organisation (index fonctionnel). Le préfixe est stable une fois posé.
CREATE UNIQUE INDEX "shops_order_number_prefix_ci_per_org"
  ON "shops" ("organizationId", UPPER("orderNumberPrefix"))
  WHERE "orderNumberPrefix" IS NOT NULL;

-- Orders : cohérence monétaire garantie en base.
ALTER TABLE "orders" ADD CONSTRAINT "orders_totals_non_negative"
  CHECK ("subtotalMinor" >= 0 AND "discountMinor" >= 0 AND "deliveryFeeMinor" >= 0 AND "totalMinor" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_total_consistent"
  CHECK ("totalMinor" = "subtotalMinor" - "discountMinor" + "deliveryFeeMinor");
ALTER TABLE "orders" ADD CONSTRAINT "orders_item_count_positive"
  CHECK ("itemCount" > 0);

-- OrderItems : quantités, montants et sémantique de consommation de stock.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_positive"
  CHECK ("quantity" > 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_prices_non_negative"
  CHECK ("unitPriceMinor" >= 0 AND "lineSubtotalMinor" >= 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_line_subtotal_consistent"
  CHECK ("lineSubtotalMinor" = "unitPriceMinor" * "quantity");
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_stock_quantities_non_negative"
  CHECK ("stockConsumedQuantity" >= 0 AND "backorderedQuantity" >= 0 AND "stockRestoredQuantity" >= 0);
-- Ligne SUIVIE : consommé + backorder = quantité (rien ne se perd) ;
-- ligne NON suivie : aucun stock consommé ni backorder.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_stock_semantics"
  CHECK (
    ("trackInventorySnapshot" AND "stockConsumedQuantity" + "backorderedQuantity" = "quantity")
    OR (NOT "trackInventorySnapshot" AND "stockConsumedQuantity" = 0 AND "backorderedQuantity" = 0)
  );
-- On ne restitue jamais plus que ce qui est réellement sorti du stock.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_restored_within_consumed"
  CHECK ("stockRestoredQuantity" <= "stockConsumedQuantity");

-- Compteur de séquence jamais négatif.
ALTER TABLE "order_sequences" ADD CONSTRAINT "order_sequences_last_value_non_negative"
  CHECK ("lastValue" >= 0);
