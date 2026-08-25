-- CreateEnum
CREATE TYPE "MessageMediaStatus" AS ENUM ('PENDING', 'DOWNLOADING', 'STORED', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "externalMediaId" TEXT,
ADD COLUMN     "mediaAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mediaErrorCode" TEXT,
ADD COLUMN     "mediaLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "mediaSha256" TEXT,
ADD COLUMN     "mediaSizeBytes" INTEGER,
ADD COLUMN     "mediaStatus" "MessageMediaStatus",
ADD COLUMN     "mediaStorageKey" TEXT;

-- CreateIndex
CREATE INDEX "messages_mediaStatus_mediaLastAttemptAt_idx" ON "messages"("mediaStatus", "mediaLastAttemptAt");
