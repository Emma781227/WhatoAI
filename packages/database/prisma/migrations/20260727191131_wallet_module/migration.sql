-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('CREDIT_PURCHASE', 'MANUAL_CREDIT', 'PROMOTIONAL_CREDIT', 'AI_USAGE_RESERVATION', 'AI_USAGE_DEBIT', 'AI_USAGE_RELEASE', 'REFUND', 'EXPIRATION', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "WalletTransactionDirection" AS ENUM ('CREDIT', 'DEBIT', 'RESERVE', 'RELEASE');

-- AlterEnum
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'WALLET_CREATED';

-- CreateTable
CREATE TABLE "wallets" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "balanceCredits" INTEGER NOT NULL DEFAULT 0,
    "reservedCredits" INTEGER NOT NULL DEFAULT 0,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "direction" "WalletTransactionDirection" NOT NULL,
    "amountCredits" INTEGER NOT NULL,
    "balanceBeforeCredits" INTEGER NOT NULL,
    "balanceAfterCredits" INTEGER NOT NULL,
    "reservedBeforeCredits" INTEGER NOT NULL,
    "reservedAfterCredits" INTEGER NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "descriptionCode" TEXT,
    "metadataFiltered" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallets_organizationId_key" ON "wallets"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_id_organizationId_key" ON "wallets"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_idempotencyKey_key" ON "wallet_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "wallet_transactions_walletId_createdAt_idx" ON "wallet_transactions"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "wallet_transactions_organizationId_createdAt_idx" ON "wallet_transactions"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "wallet_transactions_referenceType_referenceId_idx" ON "wallet_transactions"("referenceType", "referenceId");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_walletId_organizationId_fkey" FOREIGN KEY ("walletId", "organizationId") REFERENCES "wallets"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────────
-- Ajouts BRUTS (inexprimables dans schema.prisma) — CHECK, immutabilité, backfill
-- ────────────────────────────────────────────────────────────────────────────

-- Bornes de solde (répliquent les invariants du package @whauto/wallet).
ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_balance_nonneg" CHECK ("balanceCredits" >= 0),
  ADD CONSTRAINT "wallets_reserved_nonneg" CHECK ("reservedCredits" >= 0),
  ADD CONSTRAINT "wallets_reserved_le_balance" CHECK ("reservedCredits" <= "balanceCredits"),
  ADD CONSTRAINT "wallets_balance_cap" CHECK ("balanceCredits" <= 1000000000);

-- Cohérence des lignes de ledger : montant strictement positif, soldes après >= 0,
-- réservé après <= solde après (le signe est porté par `direction`).
ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_tx_amount_positive" CHECK ("amountCredits" > 0),
  ADD CONSTRAINT "wallet_tx_balance_after_nonneg" CHECK ("balanceAfterCredits" >= 0),
  ADD CONSTRAINT "wallet_tx_reserved_after_nonneg" CHECK ("reservedAfterCredits" >= 0),
  ADD CONSTRAINT "wallet_tx_reserved_le_balance_after" CHECK ("reservedAfterCredits" <= "balanceAfterCredits");

-- Ledger IMMUABLE : interdit toute MODIFICATION d'une ligne après création
-- (append-only). La suppression physique n'arrive que par cascade en test/dev
-- (les Organizations ne sont jamais supprimées en production) — d'où un trigger
-- limité à UPDATE, pour ne pas bloquer les cascades de teardown.
CREATE OR REPLACE FUNCTION "prevent_wallet_transaction_update"()
RETURNS TRIGGER AS $func$
BEGIN
  RAISE EXCEPTION 'wallet_transactions is append-only: UPDATE is forbidden'
    USING ERRCODE = 'check_violation';
END;
$func$ LANGUAGE plpgsql;

CREATE TRIGGER "wallet_transactions_no_update"
  BEFORE UPDATE ON "wallet_transactions"
  FOR EACH ROW EXECUTE FUNCTION "prevent_wallet_transaction_update"();

-- Backfill IDEMPOTENT : un Wallet ACTIVE à 0 crédit pour chaque Organization
-- existante (les nouvelles Organizations en reçoivent un dans la transaction de
-- création). Rejouable sans effet grâce au NOT EXISTS.
INSERT INTO "wallets" ("id", "organizationId", "balanceCredits", "reservedCredits", "status", "version", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", 0, 0, 'ACTIVE', 0, now(), now()
FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "wallets" w WHERE w."organizationId" = o."id");
