-- CreateEnum
CREATE TYPE "TopUpStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TopUpProvider" AS ENUM ('MOCK', 'GENIUS_PAY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'WALLET_CREDITED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'TOPUP_CREATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'TOPUP_PAID';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'TOPUP_FAILED';

-- CreateTable
CREATE TABLE "credit_packages" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "creditsGranted" INTEGER NOT NULL,
    "bonusCredits" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "creditPackageId" TEXT NOT NULL,
    "provider" "TopUpProvider" NOT NULL,
    "status" "TopUpStatus" NOT NULL DEFAULT 'PENDING',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "creditsGranted" INTEGER NOT NULL,
    "bonusCredits" INTEGER NOT NULL DEFAULT 0,
    "providerPaymentId" TEXT,
    "providerReference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "initiatedByUserId" TEXT,
    "failureCode" TEXT,
    "paidAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_packages_code_key" ON "credit_packages"("code");

-- CreateIndex
CREATE UNIQUE INDEX "topups_providerPaymentId_key" ON "topups"("providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "topups_idempotencyKey_key" ON "topups"("idempotencyKey");

-- CreateIndex
CREATE INDEX "topups_organizationId_createdAt_idx" ON "topups"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "topups_walletId_status_idx" ON "topups"("walletId", "status");

-- AddForeignKey
ALTER TABLE "topups" ADD CONSTRAINT "topups_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topups" ADD CONSTRAINT "topups_walletId_organizationId_fkey" FOREIGN KEY ("walletId", "organizationId") REFERENCES "wallets"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topups" ADD CONSTRAINT "topups_creditPackageId_fkey" FOREIGN KEY ("creditPackageId") REFERENCES "credit_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topups" ADD CONSTRAINT "topups_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────────
-- Ajouts BRUTS — CHECK de bornes + seed contrôlé des packs de crédits
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "credit_packages"
  ADD CONSTRAINT "credit_pkg_price_nonneg" CHECK ("priceMinor" >= 0),
  ADD CONSTRAINT "credit_pkg_credits_positive" CHECK ("creditsGranted" > 0),
  ADD CONSTRAINT "credit_pkg_bonus_nonneg" CHECK ("bonusCredits" >= 0);

ALTER TABLE "topups"
  ADD CONSTRAINT "topup_amount_nonneg" CHECK ("amountMinor" >= 0),
  ADD CONSTRAINT "topup_credits_positive" CHECK ("creditsGranted" > 0),
  ADD CONSTRAINT "topup_bonus_nonneg" CHECK ("bonusCredits" >= 0);

-- Seed IDEMPOTENT des packs par défaut (ON CONFLICT sur le code) — valeurs
-- AUTORITAIRES côté serveur (le frontend n'envoie que l'id du pack). Devise XAF.
INSERT INTO "credit_packages" ("id","code","name","description","priceMinor","currency","creditsGranted","bonusCredits","isActive","sortOrder","version","createdAt","updatedAt") VALUES
  (gen_random_uuid()::text,'STARTER_500','Pack Découverte','500 FCFA — pour démarrer',500,'XAF',100,0,true,1,0,now(),now()),
  (gen_random_uuid()::text,'STANDARD_2000','Pack Standard','2 000 FCFA — le plus courant',2000,'XAF',500,50,true,2,0,now(),now()),
  (gen_random_uuid()::text,'PRO_5000','Pack Pro','5 000 FCFA — meilleur rapport crédits',5000,'XAF',1500,300,true,3,0,now(),now())
ON CONFLICT ("code") DO NOTHING;
