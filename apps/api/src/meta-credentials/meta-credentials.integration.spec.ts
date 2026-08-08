import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@whauto/database';

import { SecretsEncryptionService } from '../crypto/secrets-encryption.service';
import type { PrismaService } from '../prisma/prisma.service';
import { MetaCredentialsService } from './meta-credentials.service';

/**
 * Tests d'intégration (PostgreSQL réel) des credentials Meta multi-tenant : le
 * token est CHIFFRÉ au repos (jamais en clair en base), déchiffré uniquement à la
 * demande, et la cohérence cross-tenant est garantie EN BASE (FK composites,
 * testée par SQL direct). Sans clé de chiffrement, le stockage échoue proprement.
 */

jest.setTimeout(60000);

function databaseUrl(): string {
  const raw = readFileSync('C:/Users/Emma/Desktop/Whauto AI/.env', 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL introuvable');
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
const P = prisma as unknown as PrismaService;
const KEY = randomBytes(32).toString('base64');
const secrets = new SecretsEncryptionService({ get: (k: string) => ({ SECRETS_ENCRYPTION_KEY: KEY })[k] } as unknown as ConfigService);
const service = new MetaCredentialsService(P, secrets);

const SUFFIX = `meta-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdOrgIds: string[] = [];
let seq = 0;

async function seedOrg(): Promise<string> {
  seq += 1;
  const org = await prisma.organization.create({
    data: { name: `${SUFFIX}-${seq}`, slug: `${SUFFIX}-${seq}` },
    select: { id: true },
  });
  createdOrgIds.push(org.id);
  return org.id;
}

afterAll(async () => {
  for (const id of createdOrgIds) {
    await prisma.whatsAppConnection.deleteMany({ where: { organizationId: id } });
    await prisma.metaWhatsAppCredential.deleteMany({ where: { organizationId: id } });
    await prisma.whatsAppPhoneNumber.deleteMany({ where: { organizationId: id } });
    await prisma.metaBusinessAccount.deleteMany({ where: { organizationId: id } });
    await prisma.organization.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});

describe('MetaCredentialsService — token chiffré au repos', () => {
  it('storeCredential CHIFFRE : la colonne contient une enveloppe, jamais le token en clair', async () => {
    const orgId = await seedOrg();
    const ba = await service.upsertBusinessAccount({ organizationId: orgId, businessId: 'BM-1', wabaId: `WABA-${SUFFIX}-a` });
    const TOKEN = 'EAAG-super-secret-meta-token-1234567890';

    const cred = await service.storeCredential({ organizationId: orgId, metaBusinessAccountId: ba.id, accessToken: TOKEN, scopes: ['whatsapp_business_messaging'] });

    const row = await prisma.metaWhatsAppCredential.findUniqueOrThrow({ where: { id: cred.id }, select: { accessTokenEncrypted: true } });
    expect(row.accessTokenEncrypted).not.toBe(TOKEN);
    expect(row.accessTokenEncrypted).not.toContain(TOKEN);
    expect(row.accessTokenEncrypted.startsWith('v1.')).toBe(true);

    // Déchiffrement à la demande (usage serveur).
    expect(await service.getDecryptedAccessToken(orgId, cred.id)).toBe(TOKEN);
  });

  it('getDecryptedAccessToken est tenant-scopé : autre org → NOT_FOUND', async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const ba = await service.upsertBusinessAccount({ organizationId: orgA, businessId: 'BM', wabaId: `WABA-${SUFFIX}-b` });
    const cred = await service.storeCredential({ organizationId: orgA, metaBusinessAccountId: ba.id, accessToken: 'tok' });
    await expect(service.getDecryptedAccessToken(orgB, cred.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cross-tenant EN BASE : un credential ne peut référencer une business account d’une AUTRE org (FK composite)', async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const baA = await service.upsertBusinessAccount({ organizationId: orgA, businessId: 'BM', wabaId: `WABA-${SUFFIX}-c` });
    // organizationId = B mais metaBusinessAccountId = business de A → FK composite refuse.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO meta_whatsapp_credentials (id,"organizationId","metaBusinessAccountId","accessTokenEncrypted","tokenType",status,"createdAt","updatedAt") VALUES ('${SUFFIX}-x','${orgB}','${baA.id}','v1.a.b.c.d','SYSTEM_USER','ACTIVE',now(),now())`,
      ),
    ).rejects.toThrow();
  });

  it('upsertBusinessAccount idempotent par (org, wabaId)', async () => {
    const orgId = await seedOrg();
    const first = await service.upsertBusinessAccount({ organizationId: orgId, businessId: 'BM-1', wabaId: `WABA-${SUFFIX}-d`, verifiedName: 'Boutique' });
    const second = await service.upsertBusinessAccount({ organizationId: orgId, businessId: 'BM-2', wabaId: `WABA-${SUFFIX}-d`, verifiedName: 'Boutique 2' });
    expect(second.id).toBe(first.id);
    const row = await prisma.metaBusinessAccount.findUniqueOrThrow({ where: { id: first.id }, select: { businessId: true, verifiedName: true } });
    expect(row).toMatchObject({ businessId: 'BM-2', verifiedName: 'Boutique 2' });
  });

  it('sans clé de chiffrement : storeCredential échoue proprement (jamais de token en clair stocké)', async () => {
    const orgId = await seedOrg();
    const ba = await service.upsertBusinessAccount({ organizationId: orgId, businessId: 'BM', wabaId: `WABA-${SUFFIX}-e` });
    const noKey = new MetaCredentialsService(
      P,
      new SecretsEncryptionService({ get: () => undefined } as unknown as ConfigService),
    );
    await expect(
      noKey.storeCredential({ organizationId: orgId, metaBusinessAccountId: ba.id, accessToken: 'tok' }),
    ).rejects.toMatchObject({ code: 'SECRETS_ENCRYPTION_NOT_CONFIGURED' });
    expect(await prisma.metaWhatsAppCredential.count({ where: { organizationId: orgId } })).toBe(0);
  });
});
