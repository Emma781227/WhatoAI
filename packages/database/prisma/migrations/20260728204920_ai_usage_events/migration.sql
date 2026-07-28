-- CreateEnum
CREATE TYPE "AiUsageEventStatus" AS ENUM ('PENDING', 'RESERVED', 'CHARGED', 'RELEASED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "ai_usage_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "aiRunId" TEXT NOT NULL,
    "provider" "AiProviderType" NOT NULL,
    "requestedModel" TEXT,
    "resolvedModel" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "toolRounds" INTEGER NOT NULL DEFAULT 0,
    "successfulToolCalls" INTEGER NOT NULL DEFAULT 0,
    "action" TEXT,
    "creditsReserved" INTEGER NOT NULL DEFAULT 0,
    "creditsCharged" INTEGER NOT NULL DEFAULT 0,
    "pricingVersion" TEXT,
    "reasonCode" TEXT,
    "status" "AiUsageEventStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "walletTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_events_aiRunId_key" ON "ai_usage_events"("aiRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_events_idempotencyKey_key" ON "ai_usage_events"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ai_usage_events_organizationId_createdAt_idx" ON "ai_usage_events"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_events_shopId_createdAt_idx" ON "ai_usage_events"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_events_status_idx" ON "ai_usage_events"("status");

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_walletId_organizationId_fkey" FOREIGN KEY ("walletId", "organizationId") REFERENCES "wallets"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "ai_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_walletTransactionId_fkey" FOREIGN KEY ("walletTransactionId") REFERENCES "wallet_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── CHECK de bornes (crédits) ──
ALTER TABLE "ai_usage_events"
  ADD CONSTRAINT "aiusage_reserved_nonneg" CHECK ("creditsReserved" >= 0),
  ADD CONSTRAINT "aiusage_charged_nonneg" CHECK ("creditsCharged" >= 0),
  ADD CONSTRAINT "aiusage_charged_le_reserved" CHECK ("creditsCharged" <= "creditsReserved"),
  ADD CONSTRAINT "aiusage_tools_nonneg" CHECK ("successfulToolCalls" >= 0 AND "toolRounds" >= 0);
