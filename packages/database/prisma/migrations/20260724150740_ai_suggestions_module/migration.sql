-- CreateEnum
CREATE TYPE "AiProviderType" AS ENUM ('MOCK', 'GEMINI');

-- CreateEnum
CREATE TYPE "AiMode" AS ENUM ('DISABLED', 'SUGGEST_ONLY', 'AUTO_REPLY');

-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_TOOL', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "AiSuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EDITED_AND_ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AiToolCallStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ConversationHandoffStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'RESOLVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ai_configurations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "provider" "AiProviderType" NOT NULL DEFAULT 'MOCK',
    "mode" "AiMode" NOT NULL DEFAULT 'DISABLED',
    "model" TEXT,
    "systemPromptOverride" TEXT,
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 300,
    "contextMaxMessages" INTEGER NOT NULL DEFAULT 20,
    "toolMaxRounds" INTEGER NOT NULL DEFAULT 4,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "humanHandoffEnabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_runs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "triggerMessageId" TEXT NOT NULL,
    "provider" "AiProviderType" NOT NULL,
    "model" TEXT NOT NULL,
    "mode" "AiMode" NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'QUEUED',
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "latencyMs" INTEGER,
    "toolRounds" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "supersededByRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_suggestions" (
    "id" TEXT NOT NULL,
    "aiRunId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "editedContent" TEXT,
    "status" "AiSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "contextLastMessageId" TEXT NOT NULL,
    "acceptedByUserId" TEXT,
    "sentMessageId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tool_calls" (
    "id" TEXT NOT NULL,
    "aiRunId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "argumentsFiltered" JSONB NOT NULL,
    "resultSummaryFiltered" JSONB,
    "status" "AiToolCallStatus" NOT NULL,
    "latencyMs" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_handoffs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "aiRunId" TEXT,
    "status" "ConversationHandoffStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "summary" TEXT,
    "acceptedByMembershipId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_configurations_shopId_key" ON "ai_configurations"("shopId");

-- CreateIndex
CREATE INDEX "ai_configurations_organizationId_idx" ON "ai_configurations"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_configurations_shopId_organizationId_key" ON "ai_configurations"("shopId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_runs_triggerMessageId_key" ON "ai_runs"("triggerMessageId");

-- CreateIndex
CREATE INDEX "ai_runs_organizationId_shopId_status_idx" ON "ai_runs"("organizationId", "shopId", "status");

-- CreateIndex
CREATE INDEX "ai_runs_conversationId_createdAt_idx" ON "ai_runs"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_suggestions_aiRunId_key" ON "ai_suggestions"("aiRunId");

-- CreateIndex
CREATE INDEX "ai_suggestions_conversationId_status_createdAt_idx" ON "ai_suggestions"("conversationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ai_suggestions_organizationId_shopId_status_idx" ON "ai_suggestions"("organizationId", "shopId", "status");

-- CreateIndex
CREATE INDEX "ai_tool_calls_aiRunId_round_idx" ON "ai_tool_calls"("aiRunId", "round");

-- CreateIndex
CREATE INDEX "ai_tool_calls_organizationId_shopId_toolName_idx" ON "ai_tool_calls"("organizationId", "shopId", "toolName");

-- CreateIndex
CREATE INDEX "conversation_handoffs_conversationId_status_idx" ON "conversation_handoffs"("conversationId", "status");

-- CreateIndex
CREATE INDEX "conversation_handoffs_organizationId_shopId_status_requeste_idx" ON "conversation_handoffs"("organizationId", "shopId", "status", "requestedAt");

-- AddForeignKey
ALTER TABLE "ai_configurations" ADD CONSTRAINT "ai_configurations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_configurations" ADD CONSTRAINT "ai_configurations_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_conversationId_shopId_fkey" FOREIGN KEY ("conversationId", "shopId") REFERENCES "conversations"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_triggerMessageId_fkey" FOREIGN KEY ("triggerMessageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_supersededByRunId_fkey" FOREIGN KEY ("supersededByRunId") REFERENCES "ai_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "ai_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_conversationId_shopId_fkey" FOREIGN KEY ("conversationId", "shopId") REFERENCES "conversations"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_contextLastMessageId_fkey" FOREIGN KEY ("contextLastMessageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_sentMessageId_fkey" FOREIGN KEY ("sentMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "ai_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_handoffs" ADD CONSTRAINT "conversation_handoffs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_handoffs" ADD CONSTRAINT "conversation_handoffs_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_handoffs" ADD CONSTRAINT "conversation_handoffs_conversationId_shopId_fkey" FOREIGN KEY ("conversationId", "shopId") REFERENCES "conversations"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_handoffs" ADD CONSTRAINT "conversation_handoffs_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "ai_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_handoffs" ADD CONSTRAINT "conversation_handoffs_acceptedByMembershipId_fkey" FOREIGN KEY ("acceptedByMembershipId") REFERENCES "memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Contraintes NON exprimables dans schema.prisma (index partiels + CHECK).
-- ⚠️ `prisma db push` ne les recree PAS : toujours passer par les migrations.
-- ============================================================================

-- Un seul handoff VIVANT (REQUESTED/ACCEPTED) par conversation. Les handoffs
-- RESOLVED/CANCELLED restent en historique et ne bloquent aucune demande
-- ulterieure. Garantie EN BASE, pas seulement dans le code.
CREATE UNIQUE INDEX "conversation_handoffs_one_active_per_conversation"
  ON "conversation_handoffs" ("conversationId")
  WHERE "status" IN ('REQUESTED', 'ACCEPTED');

-- Bornes de configuration : une valeur aberrante ne doit jamais pouvoir
-- atteindre le fournisseur (cout, latence, contexte non maitrise).
ALTER TABLE "ai_configurations"
  ADD CONSTRAINT "ai_configurations_max_output_tokens_bounds"
  CHECK ("maxOutputTokens" > 0 AND "maxOutputTokens" <= 8192);

ALTER TABLE "ai_configurations"
  ADD CONSTRAINT "ai_configurations_context_max_messages_bounds"
  CHECK ("contextMaxMessages" > 0 AND "contextMaxMessages" <= 100);

ALTER TABLE "ai_configurations"
  ADD CONSTRAINT "ai_configurations_tool_max_rounds_bounds"
  CHECK ("toolMaxRounds" > 0 AND "toolMaxRounds" <= 10);

-- Compteurs jamais negatifs.
ALTER TABLE "ai_runs"
  ADD CONSTRAINT "ai_runs_tool_rounds_non_negative"
  CHECK ("toolRounds" >= 0);

ALTER TABLE "ai_tool_calls"
  ADD CONSTRAINT "ai_tool_calls_round_non_negative"
  CHECK ("round" >= 0);

-- Un run ne peut pas se remplacer lui-meme (boucle de supersession).
ALTER TABLE "ai_runs"
  ADD CONSTRAINT "ai_runs_superseded_by_is_other_run"
  CHECK ("supersededByRunId" IS NULL OR "supersededByRunId" <> "id");
