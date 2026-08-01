// Overrides d'environnement AVANT l'import d'AppModule.
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.AUTH_EXPOSE_TEST_TOKENS = 'true';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.PAYMENT_PROVIDER = 'MOCK';
process.env.ALLOW_MOCK_PAYMENTS = 'true';
process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REGISTER_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REFRESH_MAX = '1000';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const RUN_ID = Date.now().toString(36);
const PASSWORD = 'e2e-password-123';

function email(tag: string): string {
  return `e2e-wallet-${RUN_ID}-${tag}@e2e.whauto.test`;
}
function tokenFromDevLink(devLink: string): string {
  return new URL(devLink).searchParams.get('token')!;
}

interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

describe('Wallet / crédits (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;

  let owner: TestUser;
  let manager: TestUser;
  let agent: TestUser;
  let orgId: string;
  let orgBId: string;
  let packageId: string;
  let packageCredits: number;

  async function verifiedUser(tag: string): Promise<TestUser> {
    const userEmail = email(tag);
    const reg = await request(server)
      .post('/api/auth/register')
      .send({ email: userEmail, password: PASSWORD, firstName: 'T', lastName: tag });
    const verifyToken = tokenFromDevLink(reg.body.devLink);
    await request(server).post('/api/auth/verify-email').send({ token: verifyToken });
    const login = await request(server).post('/api/auth/login').send({ email: userEmail, password: PASSWORD });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: userEmail }, select: { id: true } });
    return { id: user.id, email: userEmail, accessToken: login.body.accessToken };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);

    owner = await verifiedUser('owner');
    manager = await verifiedUser('manager');
    agent = await verifiedUser('agent');

    const orgRes = await request(server)
      .post('/api/organizations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: `Wallet Org ${RUN_ID}` });
    orgId = orgRes.body.organization.id;
    const orgBRes = await request(server)
      .post('/api/organizations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: `Wallet OrgB ${RUN_ID}` });
    orgBId = orgBRes.body.organization.id;

    await prisma.membership.create({ data: { userId: manager.id, organizationId: orgId, role: 'MANAGER', status: 'ACTIVE' } });
    await prisma.membership.create({ data: { userId: agent.id, organizationId: orgId, role: 'AGENT', status: 'ACTIVE' } });

    const pkg = await prisma.creditPackage.findFirstOrThrow({
      where: { isActive: true },
      orderBy: { priceMinor: 'asc' },
      select: { id: true, creditsGranted: true, bonusCredits: true },
    });
    packageId = pkg.id;
    packageCredits = pkg.creditsGranted + pkg.bonusCredits;
  });

  afterAll(async () => {
    await app.close();
  });

  const authOwner = () => ({ Authorization: `Bearer ${owner.accessToken}` });
  const authManager = () => ({ Authorization: `Bearer ${manager.accessToken}` });
  const authAgent = () => ({ Authorization: `Bearer ${agent.accessToken}` });
  const base = (org = orgId) => `/api/organizations/${org}/wallet`;

  // ------------------------------------------------------------------- lecture

  it('AGENT : GET wallet ne renvoie QUE availableCredits + aiAvailable (D7)', async () => {
    const res = await request(server).get(base()).set(authAgent());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ availableCredits: 0, aiAvailable: false });
    expect(res.body.balanceCredits).toBeUndefined();
    expect(res.body.status).toBeUndefined();
  });

  it('OWNER : GET wallet renvoie le détail comptable complet', async () => {
    const res = await request(server).get(base()).set(authOwner());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ availableCredits: 0, aiAvailable: false, balanceCredits: 0, reservedCredits: 0, status: 'ACTIVE' });
    expect(typeof res.body.version).toBe('number');
  });

  it('AGENT : GET packages → 403 (wallet.topUp requis)', async () => {
    const res = await request(server).get(`${base()}/packages`).set(authAgent());
    expect(res.status).toBe(403);
  });

  it('AGENT : GET transactions → 403 (wallet.viewLedger requis)', async () => {
    const res = await request(server).get(`${base()}/transactions`).set(authAgent());
    expect(res.status).toBe(403);
  });

  it('MANAGER : GET transactions → 200 paginé', async () => {
    const res = await request(server).get(`${base()}/transactions?page=1&limit=10`).set(authManager());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 10 });
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('OWNER : GET packages → liste les packs actifs', async () => {
    const res = await request(server).get(`${base()}/packages`).set(authOwner());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items[0]).toMatchObject({ creditsGranted: expect.any(Number), priceMinor: expect.any(Number) });
    // Jamais d'idempotencyKey ni de secret.
    expect(res.body.items[0].idempotencyKey).toBeUndefined();
  });

  // ------------------------------------------------------------------- recharge

  it('AGENT : POST top-ups → 403', async () => {
    const res = await request(server).post(`${base()}/top-ups`).set(authAgent()).send({ creditPackageId: packageId });
    expect(res.status).toBe(403);
  });

  it('OWNER : recharge complète (create → mock-confirm) crédite le Wallet', async () => {
    const create = await request(server).post(`${base()}/top-ups`).set(authOwner()).send({ creditPackageId: packageId });
    expect(create.status).toBe(201);
    expect(create.body.topUp).toMatchObject({ status: 'PENDING', creditsGranted: expect.any(Number) });
    expect(create.body.paymentSession.checkoutUrl).toContain('mock://');
    const topUpId = create.body.topUp.id;

    const confirm = await request(server).post(`${base()}/top-ups/${topUpId}/mock-confirm`).set(authOwner()).send({});
    expect(confirm.status).toBe(201);
    expect(confirm.body).toMatchObject({ status: 'PAID', alreadyPaid: false, balanceAfterCredits: packageCredits });

    const wallet = await request(server).get(base()).set(authOwner());
    expect(wallet.body.balanceCredits).toBe(packageCredits);
    expect(wallet.body.availableCredits).toBe(packageCredits);

    // Idempotence : une seconde confirmation ne recrédite pas.
    const again = await request(server).post(`${base()}/top-ups/${topUpId}/mock-confirm`).set(authOwner()).send({});
    expect(again.body).toMatchObject({ status: 'PAID', alreadyPaid: true });
    const wallet2 = await request(server).get(base()).set(authOwner());
    expect(wallet2.body.balanceCredits).toBe(packageCredits);

    // Le ledger porte le crédit d'achat.
    const tx = await request(server).get(`${base()}/transactions`).set(authOwner());
    expect(tx.body.items.some((t: { type: string }) => t.type === 'CREDIT_PURCHASE')).toBe(true);
  });

  it('cross-tenant : lire un top-up d’une autre org → 404 (anti-énumération)', async () => {
    const create = await request(server).post(`${base()}/top-ups`).set(authOwner()).send({ creditPackageId: packageId });
    const topUpId = create.body.topUp.id;
    // orgB appartient au même OWNER, mais le TopUp est rattaché à orgA.
    const res = await request(server).get(`${base(orgBId)}/top-ups/${topUpId}`).set(authOwner());
    expect(res.status).toBe(404);
  });

  it('membre AGENT : aiAvailable reflète le solde une fois le Wallet approvisionné', async () => {
    const res = await request(server).get(base()).set(authAgent());
    expect(res.body.availableCredits).toBe(packageCredits);
    expect(res.body.aiAvailable).toBe(packageCredits >= 3);
    // Toujours pas de détail comptable pour l'AGENT.
    expect(res.body.balanceCredits).toBeUndefined();
  });
});
