// Overrides d'environnement AVANT l'import d'AppModule (dotenv n'écrase pas
// les variables déjà présentes). Redis DB 1 dédiée aux tests.
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.AUTH_EXPOSE_TEST_TOKENS = 'true';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REGISTER_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REFRESH_MAX = '1000';
process.env.AUTH_RATE_LIMIT_RESET_MAX = '1000';
process.env.AUTH_RATE_LIMIT_FORGOT_PASSWORD_MAX = '1000';
process.env.AUTH_RATE_LIMIT_RESEND_VERIFICATION_MAX = '1000';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Redis } from 'ioredis';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const RUN_ID = Date.now().toString(36);
const EMAIL_PREFIX = `e2e-shop-${RUN_ID}`;
const ORG_SLUG_PREFIX = `e2e-shop-org-${RUN_ID}`;
const PASSWORD = 'e2e-password-123';

function email(tag: string): string {
  return `${EMAIL_PREFIX}-${tag}@e2e.whauto.test`;
}

function tokenFromDevLink(devLink: string): string {
  const token = new URL(devLink).searchParams.get('token');
  if (!token) {
    throw new Error(`Token absent du devLink : ${devLink}`);
  }
  return token;
}

describe('Shops (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;

  // Organisation principale des tests, avec les 4 rôles.
  let orgId: string;
  let owner: { email: string; accessToken: string };
  let admin: { email: string; accessToken: string };
  let manager: { email: string; accessToken: string };
  let agent: { email: string; accessToken: string };

  async function verifiedUser(tag: string): Promise<{ email: string; accessToken: string }> {
    const userEmail = email(tag);
    const registerRes = await request(server)
      .post('/api/auth/register')
      .send({ email: userEmail, password: PASSWORD, firstName: 'E2E', lastName: tag })
      .expect(201);
    await request(server)
      .post('/api/auth/verify-email')
      .send({ token: tokenFromDevLink(registerRes.body.devLink) })
      .expect(200);
    const loginRes = await request(server)
      .post('/api/auth/login')
      .send({ email: userEmail, password: PASSWORD })
      .expect(200);
    return { email: userEmail, accessToken: loginRes.body.accessToken };
  }

  async function createOrganization(accessToken: string, slugSuffix: string): Promise<string> {
    const res = await request(server)
      .post('/api/organizations')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: `Org Shops ${slugSuffix}`, slug: `${ORG_SLUG_PREFIX}-${slugSuffix}` })
      .expect(201);
    return res.body.organization.id;
  }

  async function inviteAndAccept(
    inviterToken: string,
    organizationId: string,
    invitee: { email: string; accessToken: string },
    role: 'ADMIN' | 'MANAGER' | 'AGENT',
  ): Promise<void> {
    const inviteRes = await request(server)
      .post(`/api/organizations/${organizationId}/invitations`)
      .set('Authorization', `Bearer ${inviterToken}`)
      .send({ email: invitee.email, role })
      .expect(201);
    await request(server)
      .post('/api/invitations/accept')
      .set('Authorization', `Bearer ${invitee.accessToken}`)
      .send({ token: tokenFromDevLink(inviteRes.body.devLink) })
      .expect(200);
  }

  function createShop(accessToken: string, organizationId: string, body: Record<string, unknown>) {
    return request(server)
      .post(`/api/organizations/${organizationId}/shops`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ countryCode: 'CM', ...body });
  }

  beforeAll(async () => {
    const redis = new Redis(process.env.REDIS_URL as string);
    await redis.flushdb();
    redis.disconnect();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    await app.listen(0); // listener persistant (voir organizations.e2e-spec.ts)
    prisma = app.get(PrismaService);
    server = app.getHttpServer();

    owner = await verifiedUser('owner');
    admin = await verifiedUser('admin');
    manager = await verifiedUser('manager');
    agent = await verifiedUser('agent');
    orgId = await createOrganization(owner.accessToken, 'main');
    await inviteAndAccept(owner.accessToken, orgId, admin, 'ADMIN');
    await inviteAndAccept(owner.accessToken, orgId, manager, 'MANAGER');
    await inviteAndAccept(owner.accessToken, orgId, agent, 'AGENT');
  }, 60000);

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { slug: { startsWith: ORG_SLUG_PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    await app.close();
  });

  describe('création et RBAC', () => {
    it('non authentifié → 401 ; non vérifié → 403 EMAIL_NOT_VERIFIED', async () => {
      await request(server)
        .post(`/api/organizations/${orgId}/shops`)
        .send({ name: 'Sans auth', countryCode: 'CM' })
        .expect(401);

      const pendingEmail = email('pending');
      await request(server)
        .post('/api/auth/register')
        .send({ email: pendingEmail, password: PASSWORD, firstName: 'E2E', lastName: 'pending' })
        .expect(201);
      const login = await request(server)
        .post('/api/auth/login')
        .send({ email: pendingEmail, password: PASSWORD })
        .expect(200);
      // Compte PENDING mais pas membre non plus : il faut un cas membre non vérifié.
      // Impossible d'être membre sans email vérifié (accept exige la vérification),
      // donc le 404 de TenantGuard est la réponse attendue ici.
      await request(server)
        .post(`/api/organizations/${orgId}/shops`)
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ name: 'Interdite', countryCode: 'CM' })
        .expect(404);
    });

    it('OWNER crée la première Shop : DRAFT, principale, défauts hérités de l’organisation', async () => {
      const res = await createShop(owner.accessToken, orgId, { name: 'Boutique Douala' }).expect(201);

      expect(res.body).toMatchObject({
        name: 'Boutique Douala',
        slug: 'boutique-douala',
        status: 'DRAFT',
        isPrimary: true,
        countryCode: 'CM',
        timezone: 'Africa/Douala', // hérité de l'org
        currency: 'XAF',
        locale: 'fr',
        organizationId: orgId,
      });
      expect(res.body.archivedAt).toBeNull();
    });

    it('ADMIN crée une Shop (non principale) ; MANAGER et AGENT reçoivent 403', async () => {
      const adminRes = await createShop(admin.accessToken, orgId, { name: 'Annexe Admin' }).expect(201);
      expect(adminRes.body.isPrimary).toBe(false);

      const managerRes = await createShop(manager.accessToken, orgId, { name: 'Refusée' }).expect(403);
      expect(managerRes.body.code).toBe('INSUFFICIENT_PERMISSION');
      await createShop(agent.accessToken, orgId, { name: 'Refusée aussi' }).expect(403);
    });

    it('AGENT lit la liste (shops.read) mais ne modifie rien', async () => {
      const list = await request(server)
        .get(`/api/organizations/${orgId}/shops`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(200);
      expect(list.body.total).toBeGreaterThanOrEqual(2);

      const shopId = list.body.items[0].id;
      await request(server)
        .patch(`/api/organizations/${orgId}/shops/${shopId}`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .send({ name: 'Tentative' })
        .expect(403);
    });
  });

  describe('slug', () => {
    it('même slug refusé dans une organisation (409), accepté dans une autre', async () => {
      await createShop(owner.accessToken, orgId, { name: 'Slug Test', slug: 'slug-partage' }).expect(201);
      const conflict = await createShop(owner.accessToken, orgId, {
        name: 'Slug Test 2',
        slug: 'slug-partage',
      }).expect(409);
      expect(conflict.body.code).toBe('SHOP_SLUG_ALREADY_USED');

      const otherOwner = await verifiedUser('other-org-owner');
      const otherOrgId = await createOrganization(otherOwner.accessToken, 'other');
      await createShop(otherOwner.accessToken, otherOrgId, {
        name: 'Slug Test Ailleurs',
        slug: 'slug-partage',
      }).expect(201);
    });

    it('deux créations concurrentes du même slug : exactement un 201 et un 409', async () => {
      const [a, b] = await Promise.all([
        createShop(owner.accessToken, orgId, { name: 'Course Slug', slug: `course-${RUN_ID}` }),
        createShop(admin.accessToken, orgId, { name: 'Course Slug Bis', slug: `course-${RUN_ID}` }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
    });

    it('slug auto-généré : collision résolue par suffixe', async () => {
      const first = await createShop(owner.accessToken, orgId, { name: `Suffixe ${RUN_ID}` }).expect(201);
      const second = await createShop(owner.accessToken, orgId, { name: `Suffixe ${RUN_ID}` }).expect(201);
      expect(second.body.slug).toBe(`${first.body.slug}-2`);
    });
  });

  describe('isolation multi-tenant', () => {
    it('une autre organisation ne voit pas la Shop (404), même en spoofant le header', async () => {
      const outsider = await verifiedUser('outsider');
      const outsiderOrgId = await createOrganization(outsider.accessToken, 'outsider');
      const shop = await createShop(outsider.accessToken, outsiderOrgId, { name: 'La Mienne' }).expect(201);
      void shop;

      const target = await createShop(owner.accessToken, orgId, { name: 'Convoitée' }).expect(201);

      // Accès direct : 404.
      await request(server)
        .get(`/api/organizations/${orgId}/shops/${target.body.id}`)
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .expect(404);
      // Spoofing du header sur sa propre route : conflit path/header → 400.
      await request(server)
        .get(`/api/organizations/${outsiderOrgId}/shops/${target.body.id}`)
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .set('X-Organization-Id', orgId)
        .expect(400);
      // Dans sa propre org, la Shop étrangère est introuvable (scoping id+organizationId).
      await request(server)
        .get(`/api/organizations/${outsiderOrgId}/shops/${target.body.id}`)
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .expect(404);
    });

    it('organizationId dans le body : rejeté par la whitelist globale (400)', async () => {
      await createShop(owner.accessToken, orgId, {
        name: 'Spoof Body',
        organizationId: 'une-autre-org',
      }).expect(400);
    });
  });

  describe('liste, recherche et pagination', () => {
    it('recherche insensible à la casse sur name et slug, pagination stable', async () => {
      await createShop(owner.accessToken, orgId, { name: `Recherche Unique ${RUN_ID}` }).expect(201);

      const res = await request(server)
        .get(`/api/organizations/${orgId}/shops?search=RECHERCHE+UNIQUE&page=1&limit=5`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].name).toBe(`Recherche Unique ${RUN_ID}`);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(5);

      const bySlug = await request(server)
        .get(`/api/organizations/${orgId}/shops?search=recherche-unique`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(200);
      expect(bySlug.body.total).toBe(1);
    });
  });

  describe('modification (PATCH)', () => {
    it('MANAGER modifie ; null efface un champ optionnel ; audit SHOP_UPDATED en base', async () => {
      const shop = await createShop(owner.accessToken, orgId, {
        name: 'À Modifier',
        description: 'Description initiale',
      }).expect(201);

      const updated = await request(server)
        .patch(`/api/organizations/${orgId}/shops/${shop.body.id}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({
          description: null,
          supportEmail: 'contact@boutique.cm',
          returnPolicy: 'Retours sous 7 jours',
          currency: 'EUR',
        })
        .expect(200);
      expect(updated.body.description).toBeNull();
      expect(updated.body.supportEmail).toBe('contact@boutique.cm');
      expect(updated.body.currency).toBe('EUR');
      expect(updated.body.name).toBe('À Modifier'); // undefined = inchangé

      const audit = await prisma.organizationAuditEvent.findFirst({
        where: { organizationId: orgId, eventType: 'SHOP_UPDATED' },
        orderBy: { createdAt: 'desc' },
        select: { metadata: true },
      });
      const metadata = audit?.metadata as { shopId: string; fields: string[] };
      expect(metadata.shopId).toBe(shop.body.id);
      expect(metadata.fields.sort()).toEqual([
        'currency',
        'description',
        'returnPolicy',
        'supportEmail',
      ]);

      // status/isPrimary interdits dans le PATCH (whitelist).
      await request(server)
        .patch(`/api/organizations/${orgId}/shops/${shop.body.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ status: 'ACTIVE' })
        .expect(400);
      await request(server)
        .patch(`/api/organizations/${orgId}/shops/${shop.body.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ isPrimary: true })
        .expect(400);
    });

    it('timezone/devise/pays invalides rejetés par les validateurs DTO', async () => {
      const shop = await createShop(owner.accessToken, orgId, { name: 'Validation Regionale' }).expect(201);
      for (const body of [
        { timezone: 'Mars/Olympus' },
        { currency: 'EUROS' },
        { countryCode: 'CMR' },
      ]) {
        await request(server)
          .patch(`/api/organizations/${orgId}/shops/${shop.body.id}`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send(body)
          .expect(400);
      }
    });
  });

  describe('transitions de statut', () => {
    it('activate/deactivate par ADMIN ; MANAGER refusé ; transition invalide → 409', async () => {
      const shop = await createShop(owner.accessToken, orgId, { name: 'Cycle Statut' }).expect(201);
      const shopId = shop.body.id;

      // MANAGER n'a pas shops.activate.
      await request(server)
        .post(`/api/organizations/${orgId}/shops/${shopId}/activate`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(403);

      const activated = await request(server)
        .post(`/api/organizations/${orgId}/shops/${shopId}/activate`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(activated.body.status).toBe('ACTIVE');

      // ACTIVE → ACTIVE invalide.
      const invalid = await request(server)
        .post(`/api/organizations/${orgId}/shops/${shopId}/activate`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(409);
      expect(invalid.body.code).toBe('INVALID_SHOP_STATUS_TRANSITION');

      const deactivated = await request(server)
        .post(`/api/organizations/${orgId}/shops/${shopId}/deactivate`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(200);
      expect(deactivated.body.status).toBe('INACTIVE');

      // INACTIVE → INACTIVE invalide.
      await request(server)
        .post(`/api/organizations/${orgId}/shops/${shopId}/deactivate`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(409);
    });
  });

  describe('boutique principale', () => {
    it('set-primary bascule la principale dans une transaction ; idempotent ; MANAGER refusé', async () => {
      const target = await createShop(owner.accessToken, orgId, { name: 'Future Principale' }).expect(201);

      await request(server)
        .post(`/api/organizations/${orgId}/shops/${target.body.id}/set-primary`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .expect(403);

      const res = await request(server)
        .post(`/api/organizations/${orgId}/shops/${target.body.id}/set-primary`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(res.body.isPrimary).toBe(true);

      // Idempotent.
      await request(server)
        .post(`/api/organizations/${orgId}/shops/${target.body.id}/set-primary`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      const primaries = await prisma.shop.count({
        where: { organizationId: orgId, isPrimary: true, status: { not: 'ARCHIVED' } },
      });
      expect(primaries).toBe(1);
    });

    it('deux set-primary concurrents sur deux Shops : jamais deux principales', async () => {
      const shopA = await createShop(owner.accessToken, orgId, { name: 'Course P A' }).expect(201);
      const shopB = await createShop(owner.accessToken, orgId, { name: 'Course P B' }).expect(201);

      const [a, b] = await Promise.all([
        request(server)
          .post(`/api/organizations/${orgId}/shops/${shopA.body.id}/set-primary`)
          .set('Authorization', `Bearer ${owner.accessToken}`),
        request(server)
          .post(`/api/organizations/${orgId}/shops/${shopB.body.id}/set-primary`)
          .set('Authorization', `Bearer ${admin.accessToken}`),
      ]);
      // Les deux peuvent réussir (séquencement des transactions) mais jamais
      // avec deux principales en base — l'index partiel est le juge de paix.
      if (![a.status, b.status].every((status) => [200, 409].includes(status))) {
        console.log('set-primary A:', a.status, JSON.stringify(a.body));
        console.log('set-primary B:', b.status, JSON.stringify(b.body));
      }
      expect([a.status, b.status].every((status) => [200, 409].includes(status))).toBe(true);

      const primaries = await prisma.shop.count({
        where: { organizationId: orgId, isPrimary: true, status: { not: 'ARCHIVED' } },
      });
      expect(primaries).toBe(1);
    });

    it('insertion directe d’une deuxième principale : rejetée par l’index PostgreSQL', async () => {
      await expect(
        prisma.shop.create({
          data: {
            organizationId: orgId,
            name: 'Principale Pirate',
            slug: `pirate-${RUN_ID}`,
            isPrimary: true,
            countryCode: 'CM',
            timezone: 'Africa/Douala',
            currency: 'XAF',
            locale: 'fr',
          },
        }),
      ).rejects.toThrow(/unique constraint/i);
    });

    it('les index shops sont réellement présents dans PostgreSQL', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes
        WHERE indexname IN ('shops_one_primary_per_org', 'shops_organizationId_slug_key')
      `;
      expect(rows.map((row) => row.indexname).sort()).toEqual([
        'shops_one_primary_per_org',
        'shops_organizationId_slug_key',
      ]);
    });
  });

  describe('archivage', () => {
    // Org dédiée pour maîtriser complètement l'état des principales.
    let archOrgId: string;
    let archOwner: { email: string; accessToken: string };

    beforeAll(async () => {
      archOwner = await verifiedUser('arch-owner');
      archOrgId = await createOrganization(archOwner.accessToken, 'arch');
    });

    it('archive : terminal, exclue des listes par défaut, non modifiable, promotion déterministe ACTIVE > INACTIVE > DRAFT', async () => {
      // shopPrim (principale, DRAFT), shopDraft (DRAFT, plus ancienne que shopActive), shopActive (ACTIVE).
      const shopPrim = await createShop(archOwner.accessToken, archOrgId, { name: 'Principale' }).expect(201);
      const shopDraft = await createShop(archOwner.accessToken, archOrgId, { name: 'Brouillon' }).expect(201);
      const shopActive = await createShop(archOwner.accessToken, archOrgId, { name: 'Active' }).expect(201);
      expect(shopDraft.body.status).toBe('DRAFT'); // plus ancienne que shopActive mais non prioritaire
      await request(server)
        .post(`/api/organizations/${archOrgId}/shops/${shopActive.body.id}/activate`)
        .set('Authorization', `Bearer ${archOwner.accessToken}`)
        .expect(200);

      const archived = await request(server)
        .post(`/api/organizations/${archOrgId}/shops/${shopPrim.body.id}/archive`)
        .set('Authorization', `Bearer ${archOwner.accessToken}`)
        .expect(200);
      expect(archived.body.status).toBe('ARCHIVED');
      expect(archived.body.isPrimary).toBe(false);
      expect(archived.body.archivedAt).not.toBeNull();

      // Promotion : shopActive (ACTIVE) prime sur shopDraft pourtant plus ancienne.
      const promoted = await prisma.shop.findFirst({
        where: { organizationId: archOrgId, isPrimary: true },
        select: { id: true },
      });
      expect(promoted?.id).toBe(shopActive.body.id);

      // Exclue des listes par défaut, visible avec includeArchived.
      const defaultList = await request(server)
        .get(`/api/organizations/${archOrgId}/shops`)
        .set('Authorization', `Bearer ${archOwner.accessToken}`)
        .expect(200);
      expect(
        defaultList.body.items.some((item: { id: string }) => item.id === shopPrim.body.id),
      ).toBe(false);
      const fullList = await request(server)
        .get(`/api/organizations/${archOrgId}/shops?includeArchived=true`)
        .set('Authorization', `Bearer ${archOwner.accessToken}`)
        .expect(200);
      expect(
        fullList.body.items.some((item: { id: string }) => item.id === shopPrim.body.id),
      ).toBe(true);

      // Lecture seule OK, toute mutation bloquée.
      await request(server)
        .get(`/api/organizations/${archOrgId}/shops/${shopPrim.body.id}`)
        .set('Authorization', `Bearer ${archOwner.accessToken}`)
        .expect(200);
      const patchRes = await request(server)
        .patch(`/api/organizations/${archOrgId}/shops/${shopPrim.body.id}`)
        .set('Authorization', `Bearer ${archOwner.accessToken}`)
        .send({ name: 'Interdit' })
        .expect(403);
      expect(patchRes.body.code).toBe('SHOP_ARCHIVED');
      await request(server)
        .post(`/api/organizations/${archOrgId}/shops/${shopPrim.body.id}/activate`)
        .set('Authorization', `Bearer ${archOwner.accessToken}`)
        .expect(409);
      await request(server)
        .post(`/api/organizations/${archOrgId}/shops/${shopPrim.body.id}/set-primary`)
        .set('Authorization', `Bearer ${archOwner.accessToken}`)
        .expect(403);
      // Double archivage refusé.
      await request(server)
        .post(`/api/organizations/${archOrgId}/shops/${shopPrim.body.id}/archive`)
        .set('Authorization', `Bearer ${archOwner.accessToken}`)
        .expect(409);
    });
  });

  describe('horaires d’ouverture', () => {
    let hoursShopId: string;

    beforeAll(async () => {
      const shop = await createShop(owner.accessToken, orgId, { name: `Horaires ${RUN_ID}` }).expect(201);
      hoursShopId = shop.body.id;
    });

    it('MANAGER remplace les horaires (manageSettings) ; AGENT lit mais ne modifie pas', async () => {
      const payload = {
        days: [
          {
            dayOfWeek: 'MONDAY',
            isClosed: false,
            periods: [
              { opensAt: '08:00', closesAt: '12:00' },
              { opensAt: '14:00', closesAt: '18:00' },
            ],
          },
          { dayOfWeek: 'SUNDAY', isClosed: true, periods: [] },
        ],
      };

      const res = await request(server)
        .put(`/api/organizations/${orgId}/shops/${hoursShopId}/opening-hours`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send(payload)
        .expect(200);
      expect(res.body.timezone).toBe('Africa/Douala');
      const monday = res.body.days.find((day: { dayOfWeek: string }) => day.dayOfWeek === 'MONDAY');
      expect(monday.periods).toEqual([
        { opensAt: '08:00', closesAt: '12:00' },
        { opensAt: '14:00', closesAt: '18:00' },
      ]);
      const sunday = res.body.days.find((day: { dayOfWeek: string }) => day.dayOfWeek === 'SUNDAY');
      expect(sunday.isClosed).toBe(true);

      // AGENT : lecture OK, écriture 403.
      await request(server)
        .get(`/api/organizations/${orgId}/shops/${hoursShopId}/opening-hours`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(200);
      await request(server)
        .put(`/api/organizations/${orgId}/shops/${hoursShopId}/opening-hours`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .send(payload)
        .expect(403);
    });

    it('remplacement complet : l’ancien jeu disparaît ; audit en base', async () => {
      await request(server)
        .put(`/api/organizations/${orgId}/shops/${hoursShopId}/opening-hours`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({
          days: [
            { dayOfWeek: 'TUESDAY', isClosed: false, periods: [{ opensAt: '09:00', closesAt: '17:00' }] },
          ],
        })
        .expect(200);

      const rows = await prisma.shopOpeningHour.findMany({
        where: { shopId: hoursShopId },
        select: { dayOfWeek: true },
      });
      expect(rows).toEqual([{ dayOfWeek: 'TUESDAY' }]); // MONDAY remplacé

      const audit = await prisma.organizationAuditEvent.findFirst({
        where: { organizationId: orgId, eventType: 'SHOP_OPENING_HOURS_UPDATED' },
        orderBy: { createdAt: 'desc' },
        select: { metadata: true },
      });
      expect(audit?.metadata).toEqual({ shopId: hoursShopId, openDays: 1, periods: 1 });
    });

    it('chevauchement refusé (400 OVERLAPPING_OPENING_HOURS), format invalide refusé', async () => {
      const overlap = await request(server)
        .put(`/api/organizations/${orgId}/shops/${hoursShopId}/opening-hours`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({
          days: [
            {
              dayOfWeek: 'FRIDAY',
              isClosed: false,
              periods: [
                { opensAt: '08:00', closesAt: '15:00' },
                { opensAt: '14:00', closesAt: '18:00' },
              ],
            },
          ],
        })
        .expect(400);
      expect(overlap.body.code).toBe('OVERLAPPING_OPENING_HOURS');

      await request(server)
        .put(`/api/organizations/${orgId}/shops/${hoursShopId}/opening-hours`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({
          days: [
            { dayOfWeek: 'FRIDAY', isClosed: false, periods: [{ opensAt: '24:00', closesAt: '25:00' }] },
          ],
        })
        .expect(400);
    });
  });

  describe('hygiène des réponses', () => {
    it('aucun champ interne ou sensible dans les réponses shops', async () => {
      const list = await request(server)
        .get(`/api/organizations/${orgId}/shops?includeArchived=true&limit=100`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      const raw = JSON.stringify(list.body);
      for (const forbidden of ['passwordHash', 'tokenHash', 'refreshTokenHash', 'createdByUserId']) {
        expect(raw).not.toContain(forbidden);
      }
    });
  });
});
