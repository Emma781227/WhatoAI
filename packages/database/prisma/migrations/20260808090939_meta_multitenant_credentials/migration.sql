-- CreateTable
CREATE TABLE "meta_business_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "verifiedName" TEXT,
    "timezone" TEXT,
    "currency" TEXT,
    "messagingLimitTier" TEXT,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_business_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meta_whatsapp_credentials" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "metaBusinessAccountId" TEXT NOT NULL,
    "accessTokenEncrypted" TEXT NOT NULL,
    "tokenType" TEXT NOT NULL DEFAULT 'SYSTEM_USER',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meta_whatsapp_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_phone_numbers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "metaBusinessAccountId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "displayPhoneNumber" TEXT,
    "verifiedName" TEXT,
    "qualityRating" TEXT,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_phone_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "whatsAppPhoneNumberId" TEXT NOT NULL,
    "metaWhatsAppCredentialId" TEXT NOT NULL,
    "webhookSecretEncrypted" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "lastHealthAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meta_business_accounts_organizationId_idx" ON "meta_business_accounts"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "meta_business_accounts_organizationId_wabaId_key" ON "meta_business_accounts"("organizationId", "wabaId");

-- CreateIndex
CREATE UNIQUE INDEX "meta_business_accounts_id_organizationId_key" ON "meta_business_accounts"("id", "organizationId");

-- CreateIndex
CREATE INDEX "meta_whatsapp_credentials_organizationId_idx" ON "meta_whatsapp_credentials"("organizationId");

-- CreateIndex
CREATE INDEX "meta_whatsapp_credentials_metaBusinessAccountId_status_idx" ON "meta_whatsapp_credentials"("metaBusinessAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "meta_whatsapp_credentials_id_organizationId_key" ON "meta_whatsapp_credentials"("id", "organizationId");

-- CreateIndex
CREATE INDEX "whatsapp_phone_numbers_organizationId_idx" ON "whatsapp_phone_numbers"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_phone_numbers_phoneNumberId_key" ON "whatsapp_phone_numbers"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_phone_numbers_id_organizationId_key" ON "whatsapp_phone_numbers"("id", "organizationId");

-- CreateIndex
CREATE INDEX "whatsapp_connections_organizationId_idx" ON "whatsapp_connections"("organizationId");

-- CreateIndex
CREATE INDEX "whatsapp_connections_shopId_status_idx" ON "whatsapp_connections"("shopId", "status");

-- AddForeignKey
ALTER TABLE "meta_business_accounts" ADD CONSTRAINT "meta_business_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_whatsapp_credentials" ADD CONSTRAINT "meta_whatsapp_credentials_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meta_whatsapp_credentials" ADD CONSTRAINT "meta_whatsapp_credentials_metaBusinessAccountId_organizati_fkey" FOREIGN KEY ("metaBusinessAccountId", "organizationId") REFERENCES "meta_business_accounts"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_phone_numbers" ADD CONSTRAINT "whatsapp_phone_numbers_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_phone_numbers" ADD CONSTRAINT "whatsapp_phone_numbers_metaBusinessAccountId_organizationI_fkey" FOREIGN KEY ("metaBusinessAccountId", "organizationId") REFERENCES "meta_business_accounts"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_shopId_organizationId_fkey" FOREIGN KEY ("shopId", "organizationId") REFERENCES "shops"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_whatsAppPhoneNumberId_organizationId_fkey" FOREIGN KEY ("whatsAppPhoneNumberId", "organizationId") REFERENCES "whatsapp_phone_numbers"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_metaWhatsAppCredentialId_organization_fkey" FOREIGN KEY ("metaWhatsAppCredentialId", "organizationId") REFERENCES "meta_whatsapp_credentials"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Index unique PARTIEL (inexprimable en Prisma) : une seule connexion WhatsApp
-- ACTIVE (CONNECTING/CONNECTED/SUSPENDED) par Shop. Un ERROR/DISCONNECTED
-- n'occupe PAS le slot (remplaçable). ⚠️ `prisma db push` ne recrée pas cet
-- index — toujours passer par les migrations.
-- ============================================================================
CREATE UNIQUE INDEX "whatsapp_connections_one_active_per_shop"
  ON "whatsapp_connections" ("shopId")
  WHERE "status" IN ('CONNECTING', 'CONNECTED', 'SUSPENDED');
