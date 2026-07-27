/*
  Warnings:

  - Added the required column `contextLastMessageId` to the `ai_runs` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ai_runs" ADD COLUMN     "contextLastMessageId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_contextLastMessageId_fkey" FOREIGN KEY ("contextLastMessageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Un seul run IA ACTIF par conversation (ajustement 8 validé).
-- Statuts actifs = QUEUED / RUNNING / WAITING_TOOL. Un run terminal
-- (SUCCEEDED/FAILED/CANCELLED/SKIPPED/SUPERSEDED) sort de l'index et ne bloque
-- plus rien. Le debounce/supersede opère SOUS verrou de la Conversation :
-- l'ancien run passe à SUPERSEDED (il quitte l'index) AVANT la création du
-- nouveau — jamais deux runs actifs simultanés, garanti EN BASE.
-- ⚠️ `prisma db push` ne recrée pas cet index : toujours passer par migration.
-- ============================================================================
CREATE UNIQUE INDEX "ai_runs_one_active_per_conversation"
  ON "ai_runs" ("conversationId")
  WHERE "status" IN ('QUEUED', 'RUNNING', 'WAITING_TOOL');
