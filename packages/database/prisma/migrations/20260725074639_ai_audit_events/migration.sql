-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'AI_CONFIGURATION_UPDATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'AI_SUGGESTION_GENERATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'AI_SUGGESTION_ACCEPTED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'AI_SUGGESTION_REJECTED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'AI_SUGGESTION_REGENERATED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'AI_HANDOFF_REQUESTED';
