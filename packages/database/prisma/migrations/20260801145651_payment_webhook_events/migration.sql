-- CreateEnum
CREATE TYPE "PaymentWebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TopUpStatus" ADD VALUE 'REFUNDED';
ALTER TYPE "TopUpStatus" ADD VALUE 'REVIEW_REQUIRED';

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" "TopUpProvider" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "providerPaymentId" TEXT,
    "eventType" TEXT NOT NULL,
    "normalizedPayload" JSONB NOT NULL,
    "status" "PaymentWebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_webhook_events_status_receivedAt_idx" ON "payment_webhook_events"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_provider_externalEventId_key" ON "payment_webhook_events"("provider", "externalEventId");
