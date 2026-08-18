-- CreateEnum
CREATE TYPE "CartItemSource" AS ENUM ('HUMAN', 'AI');

-- AlterTable
ALTER TABLE "ai_configurations" ADD COLUMN     "cartToolsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "cart_items" ADD COLUMN     "addedByAiRunId" TEXT,
ADD COLUMN     "addedBySource" "CartItemSource" NOT NULL DEFAULT 'HUMAN';

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_addedByAiRunId_fkey" FOREIGN KEY ("addedByAiRunId") REFERENCES "ai_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
