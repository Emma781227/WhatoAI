-- AlterTable
ALTER TABLE "meta_whatsapp_credentials" ADD COLUMN     "facebookUserId" TEXT;

-- CreateTable
CREATE TABLE "meta_data_deletion_requests" (
    "id" TEXT NOT NULL,
    "confirmationCode" TEXT NOT NULL,
    "facebookUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "credentialsRevoked" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "meta_data_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meta_data_deletion_requests_confirmationCode_key" ON "meta_data_deletion_requests"("confirmationCode");

-- CreateIndex
CREATE INDEX "meta_data_deletion_requests_facebookUserId_idx" ON "meta_data_deletion_requests"("facebookUserId");

-- CreateIndex
CREATE INDEX "meta_whatsapp_credentials_facebookUserId_status_idx" ON "meta_whatsapp_credentials"("facebookUserId", "status");
