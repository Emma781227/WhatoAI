-- AlterTable
ALTER TABLE "ai_suggestions" ADD COLUMN     "rejectReason" TEXT,
ADD COLUMN     "rejectedByUserId" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_rejectedByUserId_fkey" FOREIGN KEY ("rejectedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
