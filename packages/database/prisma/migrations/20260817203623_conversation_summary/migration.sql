-- CreateTable
CREATE TABLE "conversation_summaries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "coveredThroughMessageId" TEXT NOT NULL,
    "coveredMessageCount" INTEGER NOT NULL DEFAULT 0,
    "provider" "AiProviderType" NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT,
    "generatedByAiRunId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_summaries_conversationId_key" ON "conversation_summaries"("conversationId");

-- CreateIndex
CREATE INDEX "conversation_summaries_organizationId_shopId_idx" ON "conversation_summaries"("organizationId", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_summaries_conversationId_shopId_key" ON "conversation_summaries"("conversationId", "shopId");

-- AddForeignKey
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversationId_shopId_fkey" FOREIGN KEY ("conversationId", "shopId") REFERENCES "conversations"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_coveredThroughMessageId_fkey" FOREIGN KEY ("coveredThroughMessageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_generatedByAiRunId_fkey" FOREIGN KEY ("generatedByAiRunId") REFERENCES "ai_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
