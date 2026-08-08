import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@whauto/database';
import type { MetaCloudWhatsAppProvider } from '@whauto/whatsapp';

import { SecretsEncryptionService } from '../crypto/secrets-encryption.service';
import type { PrismaService } from '../prisma/prisma.service';
import { WhatsAppProviderFactory } from './whatsapp-provider.factory';

/**
 * Résolution multi-tenant du provider Meta (P1-G3). Le VRAI provider résolu est
 * exercé contre un FAUX serveur Graph : on vérifie qu'il utilise le TOKEN
 * DÉCHIFFRÉ du Shop + le phone_number_id de sa connexion (jamais l'env). Flag
 * inactif → provider pilote (env). Aucune connexion → échec explicite.
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

let server: Server;
let baseUrl: string;
let lastRequest: { url?: string; auth?: string } | null = null;

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: (k: string) =>
      ({
        META_MULTI_TENANT_ENABLED: true,
        META_GRAPH_API_BASE_URL: baseUrl,
        META_GRAPH_API_VERSION: 'v21.0',
        META_APP_SECRET: 'app-secret',
        META_ACCESS_TOKEN: 'ENV-TOKEN',
        META_PHONE_NUMBER_ID: 'ENV-PHONE',
        META_PROVIDER_CACHE_TTL_MS: 300000,
        ...overrides,
      })[k],
  } as unknown as ConfigService;
}

const SUFFIX = `wpr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdOrgIds: string[] = [];
let seq = 0;

interface Seed {
  organizationId: string;
  shopId: string;
}

async function seedConnectedShop(token: string, phoneNumberId: string): Promise<Seed> {
  seq += 1;
  const tag = `${SUFFIX}-${seq}`;
  const org = await prisma.organization.create({ data: { name: tag, slug: tag }, select: { id: true } });
  createdOrgIds.push(org.id);
  const shop = await prisma.shop.create({
    data: { organizationId: org.id, name: 'S', slug: `s-${tag}`, status: 'ACTIVE', countryCode: 'CM', timezone: 'Africa/Douala', currency: 'XAF', locale: 'fr' },
    select: { id: true },
  });
  const ba = await prisma.metaBusinessAccount.create({
    data: { organizationId: org.id, businessId: 'BM', wabaId: `WABA-${tag}` },
    select: { id: true },
  });
  const cred = await prisma.metaWhatsAppCredential.create({
    data: { organizationId: org.id, metaBusinessAccountId: ba.id, accessTokenEncrypted: secrets.encrypt(token), status: 'ACTIVE' },
    select: { id: true },
  });
  const phone = await prisma.whatsAppPhoneNumber.create({
    data: { organizationId: org.id, metaBusinessAccountId: ba.id, phoneNumberId },
    select: { id: true },
  });
  await prisma.whatsAppConnection.create({
    data: { organizationId: org.id, shopId: shop.id, whatsAppPhoneNumberId: phone.id, metaWhatsAppCredentialId: cred.id, status: 'CONNECTED' },
    select: { id: true },
  });
  return { organizationId: org.id, shopId: shop.id };
}

async function seedBareShop(): Promise<Seed> {
  seq += 1;
  const tag = `${SUFFIX}-bare-${seq}`;
  const org = await prisma.organization.create({ data: { name: tag, slug: tag }, select: { id: true } });
  createdOrgIds.push(org.id);
  const shop = await prisma.shop.create({
    data: { organizationId: org.id, name: 'S', slug: `s-${tag}`, status: 'ACTIVE', countryCode: 'CM', timezone: 'Africa/Douala', currency: 'XAF', locale: 'fr' },
    select: { id: true },
  });
  return { organizationId: org.id, shopId: shop.id };
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    lastRequest = { url: req.url, auth: req.headers.authorization as string | undefined };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', display_phone_number: '+237600000000', verified_name: 'Shop' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const id of createdOrgIds) {
    await prisma.whatsAppConnection.deleteMany({ where: { organizationId: id } });
    await prisma.metaWhatsAppCredential.deleteMany({ where: { organizationId: id } });
    await prisma.whatsAppPhoneNumber.deleteMany({ where: { organizationId: id } });
    await prisma.metaBusinessAccount.deleteMany({ where: { organizationId: id } });
    await prisma.shop.deleteMany({ where: { organizationId: id } });
    await prisma.organization.deleteMany({ where: { id } });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

beforeEach(() => {
  lastRequest = null;
});

describe('WhatsAppProviderFactory.getProviderForChannel — multi-tenant', () => {
  it('flag ON + connexion active : utilise le TOKEN DÉCHIFFRÉ + le phone_number_id du Shop', async () => {
    const seed = await seedConnectedShop('TENANT-TOKEN-abc', 'TENANT-PHONE-123');
    const factory = new WhatsAppProviderFactory(makeConfig(), P, secrets);

    const provider = await factory.getProviderForChannel({ provider: 'META_CLOUD', organizationId: seed.organizationId, shopId: seed.shopId });
    // validateConfiguration = GET Graph (aucun envoi) → observe token + numéro.
    await (provider as MetaCloudWhatsAppProvider).validateConfiguration();

    expect(lastRequest?.auth).toBe('Bearer TENANT-TOKEN-abc');
    expect(lastRequest?.url).toContain('TENANT-PHONE-123');
    // Jamais les valeurs env.
    expect(lastRequest?.auth).not.toContain('ENV-TOKEN');
  });

  it('flag OFF : provider PILOTE (token/numéro env)', async () => {
    const seed = await seedConnectedShop('TENANT-TOKEN-x', 'TENANT-PHONE-x');
    const factory = new WhatsAppProviderFactory(makeConfig({ META_MULTI_TENANT_ENABLED: false }), P, secrets);
    const provider = await factory.getProviderForChannel({ provider: 'META_CLOUD', organizationId: seed.organizationId, shopId: seed.shopId });
    await (provider as MetaCloudWhatsAppProvider).validateConfiguration();
    expect(lastRequest?.auth).toBe('Bearer ENV-TOKEN');
    expect(lastRequest?.url).toContain('ENV-PHONE');
  });

  it('flag ON + aucune connexion → WHATSAPP_CONNECTION_NOT_RESOLVED (jamais d’envoi cross-tenant)', async () => {
    const seed = await seedBareShop();
    const factory = new WhatsAppProviderFactory(makeConfig(), P, secrets);
    await expect(
      factory.getProviderForChannel({ provider: 'META_CLOUD', organizationId: seed.organizationId, shopId: seed.shopId }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_CONNECTION_NOT_RESOLVED' });
  });

  it('cache : deux résolutions du même credential renvoient la MÊME instance (pas de re-déchiffrement)', async () => {
    const seed = await seedConnectedShop('TENANT-TOKEN-cache', 'TENANT-PHONE-cache');
    const factory = new WhatsAppProviderFactory(makeConfig(), P, secrets);
    const p1 = await factory.getProviderForChannel({ provider: 'META_CLOUD', organizationId: seed.organizationId, shopId: seed.shopId });
    const p2 = await factory.getProviderForChannel({ provider: 'META_CLOUD', organizationId: seed.organizationId, shopId: seed.shopId });
    expect(p1).toBe(p2);
  });

  it('MOCK : renvoie le provider mock quel que soit le multi-tenant', async () => {
    const factory = new WhatsAppProviderFactory(makeConfig(), P, secrets);
    const provider = await factory.getProviderForChannel({ provider: 'MOCK', organizationId: 'x', shopId: 'y' });
    expect(provider.getProviderName()).toBe('MOCK');
  });
});
