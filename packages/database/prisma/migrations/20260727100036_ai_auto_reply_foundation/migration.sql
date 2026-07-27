-- CreateEnum
CREATE TYPE "AiAutoReplyScheduleMode" AS ENUM ('ALWAYS', 'OUTSIDE_BUSINESS_HOURS');

-- CreateEnum
CREATE TYPE "AiAutoReplyDecision" AS ENUM ('SENT', 'ESCALATED', 'SUPPRESSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'AI_AUTO_REPLY_SENT';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'AI_AUTO_REPLY_ESCALATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'AI_AUTO_REPLY_SUPPRESSED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'AI_AUTO_REPLY_PAUSED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'AI_AUTO_REPLY_RESUMED';

-- AlterTable
ALTER TABLE "ai_configurations" ADD COLUMN     "autoReplyAllowedCategories" TEXT[] DEFAULT ARRAY['PRODUCT_INFO', 'AVAILABILITY', 'OPENING_HOURS', 'ORDER_STATUS']::TEXT[],
ADD COLUMN     "autoReplyMaxPerConversationPerDay" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "autoReplyScheduleMode" "AiAutoReplyScheduleMode" NOT NULL DEFAULT 'ALWAYS';

-- AlterTable
ALTER TABLE "ai_runs" ADD COLUMN     "autoReplyDecision" "AiAutoReplyDecision",
ADD COLUMN     "autoReplySuppressionReason" TEXT;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "aiAutoReplyPaused" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "aiGeneratedByRunId" TEXT,
ADD COLUMN     "isAiGenerated" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_aiGeneratedByRunId_fkey" FOREIGN KEY ("aiGeneratedByRunId") REFERENCES "ai_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
