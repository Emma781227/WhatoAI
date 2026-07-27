-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('RETAIL', 'FASHION', 'BEAUTY', 'FOOD', 'RESTAURANT', 'ELECTRONICS', 'SERVICES', 'HEALTH', 'EDUCATION', 'TRAVEL', 'OTHER');

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'SHOP_CREATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'SHOP_UPDATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'SHOP_ACTIVATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'SHOP_DEACTIVATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'SHOP_SET_PRIMARY';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'SHOP_ARCHIVED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'SHOP_OPENING_HOURS_UPDATED';

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" "ShopStatus" NOT NULL DEFAULT 'DRAFT',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "businessType" "BusinessType",
    "logoUrl" TEXT,
    "coverUrl" TEXT,
    "websiteUrl" TEXT,
    "supportEmail" TEXT,
    "supportPhone" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "countryCode" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "returnPolicy" TEXT,
    "deliveryPolicy" TEXT,
    "orderInstructions" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_opening_hours" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "dayOfWeek" "DayOfWeek" NOT NULL,
    "opensAtMinutes" INTEGER NOT NULL,
    "closesAtMinutes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_opening_hours_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shops_organizationId_status_idx" ON "shops"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shops_organizationId_slug_key" ON "shops"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "shop_opening_hours_shopId_dayOfWeek_idx" ON "shop_opening_hours"("shopId", "dayOfWeek");

-- AddForeignKey
ALTER TABLE "shops" ADD CONSTRAINT "shops_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shops" ADD CONSTRAINT "shops_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_opening_hours" ADD CONSTRAINT "shop_opening_hours_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Index unique PARTIEL ajouté à la main (inexprimable dans schema.prisma).
-- ATTENTION : il n'existe QUE dans ce fichier de migration. `prisma db push`
-- ne le recrée pas — le seed échoue s'il manque (voir CLAUDE.md).
-- ============================================================================

-- Garantie structurelle : au plus une Shop principale non archivée par
-- organisation, même sous accès concurrent. Deux set-primary ou deux créations
-- de "première Shop" simultanés → l'un des deux échoue avec P2002.
CREATE UNIQUE INDEX "shops_one_primary_per_org"
ON "shops" ("organizationId")
WHERE "isPrimary" = true AND "status" <> 'ARCHIVED';
