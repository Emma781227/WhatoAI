-- CreateEnum
CREATE TYPE "ProductCategoryStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('PHYSICAL', 'SERVICE', 'DIGITAL');

-- CreateEnum
CREATE TYPE "ProductVariantStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('INITIAL', 'ADJUSTMENT', 'RESTOCK', 'DAMAGE', 'RETURN', 'RESERVATION', 'RELEASE', 'SALE', 'CANCELLATION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CATEGORY_CREATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CATEGORY_UPDATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'CATEGORY_ARCHIVED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'PRODUCT_CREATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'PRODUCT_UPDATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'PRODUCT_ACTIVATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'PRODUCT_DEACTIVATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'PRODUCT_ARCHIVED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'VARIANT_CREATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'VARIANT_UPDATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'VARIANT_ARCHIVED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'INVENTORY_ADJUSTED';

-- CreateTable
CREATE TABLE "product_categories" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "status" "ProductCategoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "shortDescription" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "productType" "ProductType" NOT NULL DEFAULT 'PHYSICAL',
    "currency" TEXT NOT NULL,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "status" "ProductVariantStatus" NOT NULL DEFAULT 'ACTIVE',
    "priceMinor" INTEGER NOT NULL,
    "compareAtPriceMinor" INTEGER,
    "costPriceMinor" INTEGER,
    "trackInventory" BOOLEAN NOT NULL DEFAULT true,
    "allowBackorder" BOOLEAN NOT NULL DEFAULT false,
    "weightGrams" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "combinationKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_options" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_option_values" (
    "id" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_option_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variant_option_values" (
    "variantId" TEXT NOT NULL,
    "optionValueId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_variant_option_values_pkey" PRIMARY KEY ("variantId","optionValueId")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "url" TEXT NOT NULL,
    "altText" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantityOnHand" INTEGER NOT NULL DEFAULT 0,
    "quantityReserved" INTEGER NOT NULL DEFAULT 0,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 5,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "quantityBefore" INTEGER NOT NULL,
    "quantityAfter" INTEGER NOT NULL,
    "reason" TEXT,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_categories_organizationId_shopId_status_idx" ON "product_categories"("organizationId", "shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_shopId_slug_key" ON "product_categories"("shopId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_id_shopId_key" ON "product_categories"("id", "shopId");

-- CreateIndex
CREATE INDEX "products_organizationId_shopId_status_idx" ON "products"("organizationId", "shopId", "status");

-- CreateIndex
CREATE INDEX "products_shopId_categoryId_idx" ON "products"("shopId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "products_shopId_slug_key" ON "products"("shopId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "products_id_shopId_key" ON "products"("id", "shopId");

-- CreateIndex
CREATE INDEX "product_variants_productId_status_idx" ON "product_variants"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_shopId_sku_key" ON "product_variants"("shopId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_shopId_barcode_key" ON "product_variants"("shopId", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_id_shopId_key" ON "product_variants"("id", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_id_productId_key" ON "product_variants"("id", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "product_options_productId_name_key" ON "product_options"("productId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "product_options_id_productId_key" ON "product_options"("id", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "product_option_values_optionId_value_key" ON "product_option_values"("optionId", "value");

-- CreateIndex
CREATE UNIQUE INDEX "product_option_values_id_optionId_key" ON "product_option_values"("id", "optionId");

-- CreateIndex
CREATE UNIQUE INDEX "product_variant_option_values_variantId_optionId_key" ON "product_variant_option_values"("variantId", "optionId");

-- CreateIndex
CREATE INDEX "product_images_productId_position_idx" ON "product_images"("productId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_variantId_key" ON "inventory_items"("variantId");

-- CreateIndex
CREATE INDEX "inventory_items_organizationId_shopId_idx" ON "inventory_items"("organizationId", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_variantId_shopId_key" ON "inventory_items"("variantId", "shopId");

-- CreateIndex
CREATE INDEX "inventory_movements_variantId_createdAt_idx" ON "inventory_movements"("variantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "inventory_movements_organizationId_shopId_idx" ON "inventory_movements"("organizationId", "shopId");

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_shopId_fkey" FOREIGN KEY ("categoryId", "shopId") REFERENCES "product_categories"("id", "shopId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_productId_shopId_fkey" FOREIGN KEY ("productId", "shopId") REFERENCES "products"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_productId_shopId_fkey" FOREIGN KEY ("productId", "shopId") REFERENCES "products"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_values" ADD CONSTRAINT "product_option_values_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "product_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant_option_values" ADD CONSTRAINT "product_variant_option_values_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "product_variants"("id", "productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant_option_values" ADD CONSTRAINT "product_variant_option_values_optionId_productId_fkey" FOREIGN KEY ("optionId", "productId") REFERENCES "product_options"("id", "productId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variant_option_values" ADD CONSTRAINT "product_variant_option_values_optionValueId_optionId_fkey" FOREIGN KEY ("optionValueId", "optionId") REFERENCES "product_option_values"("id", "optionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_productId_shopId_fkey" FOREIGN KEY ("productId", "shopId") REFERENCES "products"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_variantId_productId_fkey" FOREIGN KEY ("variantId", "productId") REFERENCES "product_variants"("id", "productId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_variantId_shopId_fkey" FOREIGN KEY ("variantId", "shopId") REFERENCES "product_variants"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_variantId_shopId_fkey" FOREIGN KEY ("variantId", "shopId") REFERENCES "product_variants"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- Contraintes ajoutées à la main (inexprimables dans schema.prisma).
-- ATTENTION : elles n'existent QUE dans ce fichier de migration. `prisma db
-- push` ne les recrée pas — le seed échoue si elles manquent (voir CLAUDE.md).
-- ============================================================================

-- Nom de catégorie unique par Shop, INSENSIBLE À LA CASSE, hors archivées.
CREATE UNIQUE INDEX "product_categories_unique_name_ci_per_shop"
ON "product_categories" ("shopId", lower("name"))
WHERE "status" <> 'ARCHIVED';

-- Une seule variante par défaut non archivée par produit, même sous accès
-- concurrent (l'archivage de la DEFAULT déclenche une promotion transactionnelle).
CREATE UNIQUE INDEX "product_variants_one_default_per_product"
ON "product_variants" ("productId")
WHERE "isDefault" = true AND "status" <> 'ARCHIVED';

-- Une combinaison d'options VIVANTE unique par produit. combinationKey est la
-- forme canonique (noms/valeurs normalisés, triés) calculée par le service —
-- deux variantes ne peuvent jamais porter la même combinaison, même en course.
CREATE UNIQUE INDEX "product_variants_unique_combination_per_product"
ON "product_variants" ("productId", "combinationKey")
WHERE "status" <> 'ARCHIVED';

-- Une seule image principale par produit.
CREATE UNIQUE INDEX "product_images_one_primary_per_product"
ON "product_images" ("productId")
WHERE "isPrimary" = true;

-- Défense en profondeur sous les validations service (jamais de montant
-- négatif, jamais de stock physique négatif — même avec backorder :
-- c'est quantityReserved qui peut dépasser quantityOnHand).
ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_price_non_negative" CHECK ("priceMinor" >= 0),
  ADD CONSTRAINT "product_variants_compare_at_above_price"
    CHECK ("compareAtPriceMinor" IS NULL OR "compareAtPriceMinor" > "priceMinor"),
  ADD CONSTRAINT "product_variants_cost_non_negative"
    CHECK ("costPriceMinor" IS NULL OR "costPriceMinor" >= 0);

ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_on_hand_non_negative" CHECK ("quantityOnHand" >= 0),
  ADD CONSTRAINT "inventory_items_reserved_non_negative" CHECK ("quantityReserved" >= 0);
