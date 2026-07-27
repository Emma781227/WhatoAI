-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MessageType" ADD VALUE 'STICKER';
ALTER TYPE "MessageType" ADD VALUE 'UNSUPPORTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'META_CHANNEL_CONNECTED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'META_CHANNEL_TESTED';
ALTER TYPE "OrganizationAuditEventType" ADD VALUE 'META_CHANNEL_ERROR';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WhatsAppInboundEventStatus" ADD VALUE 'WAITING_MESSAGE';
ALTER TYPE "WhatsAppInboundEventStatus" ADD VALUE 'ORPHANED';

-- AlterTable
ALTER TABLE "whatsapp_channels" ADD COLUMN     "displayPhoneNumber" TEXT,
ADD COLUMN     "lastWebhookAt" TIMESTAMP(3),
ADD COLUMN     "verifiedName" TEXT;

