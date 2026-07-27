/*
  Warnings:

  - Added the required column `updatedAt` to the `memberships` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "InvitationRole" AS ENUM ('ADMIN', 'MANAGER', 'AGENT');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'LEFT');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OrganizationAuditEventType" AS ENUM ('ORGANIZATION_CREATED', 'ORGANIZATION_UPDATED', 'ORGANIZATION_ARCHIVED', 'MEMBER_INVITED', 'INVITATION_RESENT', 'INVITATION_ACCEPTED', 'INVITATION_DECLINED', 'INVITATION_CANCELLED', 'MEMBER_ROLE_CHANGED', 'MEMBER_REMOVED', 'MEMBER_LEFT');

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "defaultCurrency" TEXT NOT NULL DEFAULT 'XAF',
ADD COLUMN     "defaultLocale" TEXT NOT NULL DEFAULT 'fr',
ADD COLUMN     "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Africa/Douala';

-- CreateTable
CREATE TABLE "organization_invitations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "InvitationRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invitedByUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_audit_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "targetUserId" TEXT,
    "eventType" "OrganizationAuditEventType" NOT NULL,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_tokenHash_key" ON "organization_invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "organization_invitations_organizationId_idx" ON "organization_invitations"("organizationId");

-- CreateIndex
CREATE INDEX "organization_invitations_email_idx" ON "organization_invitations"("email");

-- CreateIndex
CREATE INDEX "organization_audit_events_organizationId_idx" ON "organization_audit_events"("organizationId");

-- CreateIndex
CREATE INDEX "organization_audit_events_eventType_idx" ON "organization_audit_events"("eventType");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_audit_events" ADD CONSTRAINT "organization_audit_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_audit_events" ADD CONSTRAINT "organization_audit_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_audit_events" ADD CONSTRAINT "organization_audit_events_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Index uniques PARTIELS ajoutés à la main (inexprimables dans schema.prisma).
-- ATTENTION : ils n'existent QUE dans ce fichier de migration. Un `prisma db push`
-- ou une régénération du schéma ne les recréera pas — voir CLAUDE.md.
-- ============================================================================

-- Garantie anti-concurrence : une seule invitation PENDING par (organisation, email).
-- Deux créations simultanées → l'une échoue avec P2002.
CREATE UNIQUE INDEX "organization_invitations_one_pending_per_org_email"
ON "organization_invitations" ("organizationId", "email")
WHERE "status" = 'PENDING';

-- Garantie structurelle : un seul OWNER ACTIVE par organisation, même sous
-- accès concurrent. Le modèle "OWNER unique sans transfert" est ainsi
-- appliqué au niveau PostgreSQL, pas seulement dans le code.
CREATE UNIQUE INDEX "memberships_one_active_owner_per_org"
ON "memberships" ("organizationId")
WHERE "role" = 'OWNER' AND "status" = 'ACTIVE';
