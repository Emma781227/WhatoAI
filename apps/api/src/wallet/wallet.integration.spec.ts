import { readFileSync } from 'node:fs';

import { PrismaClient } from '@whauto/database';

import type { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';

/**
 * Tests d'INTÉGRATION du Wallet (groupe 1) contre la vraie base : provisioning,
 * idempotence, concurrence, cohérence cross-tenant, CHECK et immutabilité du
 * ledger ne se prouvent qu'avec de vraies contraintes/triggers PostgreSQL.
 */

jest.setTimeout(60000);

function databaseUrl(): string {
  const raw = readFileSync('C:/Users/Emma/Desktop/Whauto AI/.env', 'utf8');
  const line = raw.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL introuvable');
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
const service = new WalletService(prisma as unknown as PrismaService);
const SUFFIX = `wallet-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const createdOrgIds: string[] = [];

async function freshOrg(tag: string): Promise<string> {
  const org = await prisma.organization.create({
    data: { name: `W ${tag} ${SUFFIX}`, slug: `w-${tag}-${SUFFIX}` },
    select: { id: true },
  });
  createdOrgIds.push(org.id);
  // Une org seedée directement n'a PAS de wallet (l'auto-provisioning vit dans
  // OrganizationsService.create) — c'est justement ce que teste ensureWallet.
  return org.id;
}

afterAll(async () => {
  for (const id of createdOrgIds) {
    await prisma.walletTransaction.deleteMany({ where: { organizationId: id } });
    await prisma.wallet.deleteMany({ where: { organizationId: id } });
    await prisma.organization.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});

describe('WalletService — provisioning & idempotence', () => {
  it('ensureWallet crée un Wallet ACTIVE à 0 crédit puis est idempotent', async () => {
    const orgId = await freshOrg('ensure');
    const first = await service.ensureWallet(orgId);
    expect(first).toMatchObject({ balanceCredits: 0, reservedCredits: 0, availableCredits: 0, status: 'ACTIVE' });

    const second = await service.ensureWallet(orgId);
    expect(second.id).toBe(first.id); // même wallet, aucun doublon

    const count = await prisma.wallet.count({ where: { organizationId: orgId } });
    expect(count).toBe(1);
  });

  it('createInTx provisionne le Wallet dans une transaction fournie', async () => {
    const orgId = await freshOrg('createintx');
    const created = await prisma.$transaction((tx) => service.createInTx(tx, orgId));
    expect(created.id).toBeTruthy();
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { organizationId: orgId },
      select: { id: true, balanceCredits: true, status: true },
    });
    expect(wallet).toMatchObject({ id: created.id, balanceCredits: 0, status: 'ACTIVE' });
    expect(await prisma.wallet.count({ where: { organizationId: orgId } })).toBe(1);
  });

  it('concurrence : deux ensureWallet simultanés → UN seul Wallet', async () => {
    const orgId = await freshOrg('concurrent');
    const [a, b] = await Promise.all([service.ensureWallet(orgId), service.ensureWallet(orgId)]);
    expect(a.id).toBe(b.id);
    expect(await prisma.wallet.count({ where: { organizationId: orgId } })).toBe(1);
  });
});

describe('Wallet — invariants EN BASE (CHECK / unique / immutabilité / cross-tenant)', () => {
  it('un seul Wallet par Organization (unique organizationId)', async () => {
    const orgId = await freshOrg('unique');
    await service.ensureWallet(orgId);
    await expect(
      prisma.wallet.create({ data: { organizationId: orgId } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('CHECK : balance négative refusée', async () => {
    const orgId = await freshOrg('checkneg');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO wallets (id,"organizationId","balanceCredits","reservedCredits",status,version,"createdAt","updatedAt") VALUES ('${SUFFIX}-neg','${orgId}',-1,0,'ACTIVE',0,now(),now())`,
      ),
    ).rejects.toThrow();
  });

  it('CHECK : reserved > balance refusé', async () => {
    const orgId = await freshOrg('checkres');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO wallets (id,"organizationId","balanceCredits","reservedCredits",status,version,"createdAt","updatedAt") VALUES ('${SUFFIX}-res','${orgId}',5,10,'ACTIVE',0,now(),now())`,
      ),
    ).rejects.toThrow();
  });

  it('ledger APPEND-ONLY : UPDATE d’une WalletTransaction refusé (trigger)', async () => {
    const orgId = await freshOrg('immut');
    const wallet = await service.ensureWallet(orgId);
    const tx = await prisma.walletTransaction.create({
      data: {
        organizationId: orgId,
        walletId: wallet.id,
        type: 'MANUAL_CREDIT',
        direction: 'CREDIT',
        amountCredits: 10,
        balanceBeforeCredits: 0,
        balanceAfterCredits: 10,
        reservedBeforeCredits: 0,
        reservedAfterCredits: 0,
        idempotencyKey: `${SUFFIX}-immut`,
      },
      select: { id: true },
    });
    await expect(
      prisma.$executeRawUnsafe(`UPDATE wallet_transactions SET "amountCredits"=999 WHERE id='${tx.id}'`),
    ).rejects.toThrow();
  });

  it('cross-tenant : une WalletTransaction ne peut référencer un Wallet d’une AUTRE org (FK composite)', async () => {
    const orgA = await freshOrg('crossa');
    const orgB = await freshOrg('crossb');
    const walletA = await service.ensureWallet(orgA);
    await service.ensureWallet(orgB);
    // organizationId = orgB mais walletId = wallet de orgA → la FK composite refuse.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO wallet_transactions (id,"organizationId","walletId",type,direction,"amountCredits","balanceBeforeCredits","balanceAfterCredits","reservedBeforeCredits","reservedAfterCredits","idempotencyKey","createdAt") VALUES ('${SUFFIX}-cross','${orgB}','${walletA.id}','MANUAL_CREDIT','CREDIT',1,0,1,0,0,'${SUFFIX}-cross-key',now())`,
      ),
    ).rejects.toThrow();
  });

  it('idempotencyKey unique sur le ledger', async () => {
    const orgId = await freshOrg('idem');
    const wallet = await service.ensureWallet(orgId);
    const base = {
      organizationId: orgId,
      walletId: wallet.id,
      type: 'MANUAL_CREDIT' as const,
      direction: 'CREDIT' as const,
      amountCredits: 5,
      balanceBeforeCredits: 0,
      balanceAfterCredits: 5,
      reservedBeforeCredits: 0,
      reservedAfterCredits: 0,
      idempotencyKey: `${SUFFIX}-dup`,
    };
    await prisma.walletTransaction.create({ data: base });
    await expect(
      prisma.walletTransaction.create({ data: { ...base, balanceBeforeCredits: 5, balanceAfterCredits: 10 } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
