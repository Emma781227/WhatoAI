// Overrides d'environnement AVANT l'import d'AppModule.
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
const EMAIL_PREFIX = `e2e-cat-${RUN_ID}`;
const PASSWORD = 'e2e-password-123';

function email(tag: string): string {
  return `${EMAIL_PREFIX}-${tag}@e2e.whauto.test`;
}

function tokenFromDevLink(devLink: string): string {
  return new URL(devLink).searchParams.get('token')!;
}

interface TestUser {
  email: string;
  accessToken: string;
}

describe('Catalogue (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;

  let owner: TestUser;
  let agent: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let orgBId: string;
  let shopId: string;
  let shop2Id: string;
  let shopBId: string;

  async function verifiedUser(tag: string): Promise<TestUser> {
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

  function authed(user: TestUser) {
    const withAuth = (method: 'get' | 'post' | 'patch' | 'put' | 'delete') => (path: string) =>
      request(server)[method](path).set('Authorization', `Bearer ${user.accessToken}`);
    return {
      get: withAuth('get'),
      post: withAuth('post'),
      patch: withAuth('patch'),
      put: withAuth('put'),
      delete: withAuth('delete'),
    };
  }

  const productsBase = (org: string, shop: string) =>
    `/api/organizations/${org}/shops/${shop}/products`;
  const categoriesBase = (org: string, shop: string) =>
    `/api/organizations/${org}/shops/${shop}/categories`;

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
    await app.listen(0);
    prisma = app.get(PrismaService);
    server = app.getHttpServer();

    owner = await verifiedUser('owner');
    agent = await verifiedUser('agent');
    outsider = await verifiedUser('outsider');

    const orgRes = await authed(owner)
      .post('/api/organizations')
      .send({ name: `Cat Org ${RUN_ID}`, slug: `e2e-cat-org-${RUN_ID}` })
      .expect(201);
    orgId = orgRes.body.organization.id;

    const inviteRes = await authed(owner)
      .post(`/api/organizations/${orgId}/invitations`)
      .send({ email: agent.email, role: 'AGENT' })
      .expect(201);
    await authed(agent)
      .post('/api/invitations/accept')
      .send({ token: tokenFromDevLink(inviteRes.body.devLink) })
      .expect(200);

    const shopRes = await authed(owner)
      .post(`/api/organizations/${orgId}/shops`)
      .send({ name: `Cat Shop ${RUN_ID}`, countryCode: 'CM' })
      .expect(201);
    shopId = shopRes.body.id;
    const shop2Res = await authed(owner)
      .post(`/api/organizations/${orgId}/shops`)
      .send({ name: `Cat Shop 2 ${RUN_ID}`, countryCode: 'CM' })
      .expect(201);
    shop2Id = shop2Res.body.id;

    const orgBRes = await authed(outsider)
      .post('/api/organizations')
      .send({ name: `Cat Org B ${RUN_ID}`, slug: `e2e-cat-orgb-${RUN_ID}` })
      .expect(201);
    orgBId = orgBRes.body.organization.id;
    const shopBRes = await authed(outsider)
      .post(`/api/organizations/${orgBId}/shops`)
      .send({ name: `Cat Shop B ${RUN_ID}`, countryCode: 'CM' })
      .expect(201);
    shopBId = shopBRes.body.id;
  }, 120000);

  afterAll(async () => {
    await app?.close();
  });

  // ------------------------------------------------------------ catégories

  describe('Catégories', () => {
    it('création avec slug généré + audit', async () => {
      const res = await authed(owner)
        .post(categoriesBase(orgId, shopId))
        .send({ name: 'Chaussures' })
        .expect(201);
      expect(res.body.slug).toBe('chaussures');
      const audit = await prisma.organizationAuditEvent.findFirst({
        where: { organizationId: orgId, eventType: 'CATEGORY_CREATED' },
      });
      expect(audit).not.toBeNull();
    });

    it('même slug accepté dans une autre Shop, refusé dans la même', async () => {
      await authed(owner)
        .post(categoriesBase(orgId, shop2Id))
        .send({ name: 'Chaussures' })
        .expect(201);
      const dup = await authed(owner)
        .post(categoriesBase(orgId, shopId))
        .send({ name: 'Autre', slug: 'chaussures' })
        .expect(409);
      expect(dup.body.code).toBe('CATEGORY_SLUG_ALREADY_USED');
    });

    it('nom en doublon INSENSIBLE À LA CASSE refusé dans une Shop', async () => {
      const res = await authed(owner)
        .post(categoriesBase(orgId, shopId))
        .send({ name: 'CHAUSSURES', slug: 'chaussures-bis' })
        .expect(409);
      expect(res.body.code).toBe('CATEGORY_NAME_ALREADY_USED');
    });

    it('archivage : produits liés conservent categoryId (jamais de mise à null)', async () => {
      const catRes = await authed(owner)
        .post(categoriesBase(orgId, shopId))
        .send({ name: 'Éphémère' })
        .expect(201);
      const prodRes = await authed(owner)
        .post(productsBase(orgId, shopId))
        .send({
          name: `Produit catégorisé ${RUN_ID}`,
          categoryId: catRes.body.id,
          variants: [{ sku: `CAT-KEEP-${RUN_ID}`, priceMinor: 1000 }],
        })
        .expect(201);
      await authed(owner)
        .post(`${categoriesBase(orgId, shopId)}/${catRes.body.id}/archive`)
        .expect(200);

      const detail = await authed(owner)
        .get(`${productsBase(orgId, shopId)}/${prodRes.body.id}`)
        .expect(200);
      expect(detail.body.categoryId).toBe(catRes.body.id);
      expect(detail.body.category.status).toBe('ARCHIVED');
      // …mais elle n'est plus assignable à un nouveau produit.
      const refused = await authed(owner)
        .post(productsBase(orgId, shopId))
        .send({
          name: 'Refusé',
          categoryId: catRes.body.id,
          variants: [{ sku: `CAT-REF-${RUN_ID}`, priceMinor: 1000 }],
        })
        .expect(409);
      expect(refused.body.code).toBe('CATEGORY_ARCHIVED');
    });
  });

  // ------------------------------------------------------------ produits

  describe('Produits', () => {
    let simpleId: string;
    let multiId: string;

    it('produit simple : variante DEFAULT créée, stock initial + mouvement INITIAL', async () => {
      const res = await authed(owner)
        .post(productsBase(orgId, shopId))
        .send({
          name: `Simple ${RUN_ID}`,
          variants: [{ sku: `SIMPLE-${RUN_ID}`, priceMinor: 5000, initialQuantity: 10 }],
        })
        .expect(201);
      simpleId = res.body.id;
      expect(res.body.status).toBe('DRAFT');
      expect(res.body.variants).toHaveLength(1);
      const variant = res.body.variants[0];
      expect(variant.isDefault).toBe(true);
      expect(variant.sku).toBe(`SIMPLE-${RUN_ID}`.toUpperCase());
      expect(variant.inventory.quantityOnHand).toBe(10);

      const dbVariant = await prisma.productVariant.findUniqueOrThrow({
        where: { id: variant.id },
        select: { combinationKey: true },
      });
      expect(dbVariant.combinationKey).toBe('DEFAULT');

      const movement = await prisma.inventoryMovement.findFirst({
        where: { variantId: variant.id, type: 'INITIAL' },
      });
      expect(movement).toMatchObject({ quantityDelta: 10, quantityBefore: 0, quantityAfter: 10 });
    });

    it('produit multi-variantes : combinaisons uniques créées transactionnellement', async () => {
      const res = await authed(owner)
        .post(productsBase(orgId, shopId))
        .send({
          name: `Tee-shirt ${RUN_ID}`,
          options: [
            { name: 'Taille', values: ['S', 'M'] },
            { name: 'Couleur', values: ['Rouge', 'Bleu'] },
          ],
          variants: [
            { sku: `TEE-S-R-${RUN_ID}`, priceMinor: 8000, initialQuantity: 5, optionSelections: [{ optionName: 'Taille', value: 'S' }, { optionName: 'Couleur', value: 'Rouge' }] },
            { sku: `TEE-S-B-${RUN_ID}`, priceMinor: 8000, initialQuantity: 2, lowStockThreshold: 3, optionSelections: [{ optionName: 'Taille', value: 'S' }, { optionName: 'Couleur', value: 'Bleu' }] },
            { sku: `TEE-M-R-${RUN_ID}`, priceMinor: 9000, initialQuantity: 0, optionSelections: [{ optionName: 'Taille', value: 'M' }, { optionName: 'Couleur', value: 'Rouge' }] },
            { sku: `TEE-M-B-${RUN_ID}`, priceMinor: 9000, initialQuantity: 0, allowBackorder: true, optionSelections: [{ optionName: 'Taille', value: 'M' }, { optionName: 'Couleur', value: 'Bleu' }] },
          ],
        })
        .expect(201);
      multiId = res.body.id;
      expect(res.body.options).toHaveLength(2);
      expect(res.body.variants).toHaveLength(4);
      expect(res.body.variants.filter((v: { isDefault: boolean }) => v.isDefault)).toHaveLength(1);
    });

    it('ajout d’une variante avec combinaison EXISTANTE refusé (ordre et casse indifférents)', async () => {
      const res = await authed(owner)
        .post(`${productsBase(orgId, shopId)}/${multiId}/variants`)
        .send({
          sku: `TEE-DUP-${RUN_ID}`,
          priceMinor: 8000,
          optionSelections: [
            { optionName: 'couleur', value: 'ROUGE' },
            { optionName: 'taille', value: 's' },
          ],
        })
        .expect(409);
      expect(res.body.code).toBe('DUPLICATE_VARIANT_COMBINATION');
    });

    it('SKU en doublon refusé dans la Shop (insensible à la casse), accepté dans une autre Shop', async () => {
      const dup = await authed(owner)
        .post(productsBase(orgId, shopId))
        .send({
          name: 'Doublon SKU',
          variants: [{ sku: `simple-${RUN_ID}`, priceMinor: 100 }],
        })
        .expect(409);
      expect(dup.body.code).toBe('VARIANT_SKU_ALREADY_USED');

      await authed(owner)
        .post(productsBase(orgId, shop2Id))
        .send({
          name: 'Même SKU autre Shop',
          variants: [{ sku: `SIMPLE-${RUN_ID}`, priceMinor: 100 }],
        })
        .expect(201);
    });

    it('activation refusée sans variante ACTIVE, acceptée sinon', async () => {
      // Désactive la seule variante du produit simple (produit DRAFT → autorisé).
      const detail = await authed(owner)
        .get(`${productsBase(orgId, shopId)}/${simpleId}`)
        .expect(200);
      const variantId = detail.body.variants[0].id;
      await authed(owner)
        .post(`${productsBase(orgId, shopId)}/${simpleId}/variants/${variantId}/deactivate`)
        .expect(200);

      const refused = await authed(owner)
        .post(`${productsBase(orgId, shopId)}/${simpleId}/activate`)
        .expect(422);
      expect(refused.body.code).toBe('PRODUCT_ACTIVATION_REQUIREMENTS');

      await authed(owner)
        .post(`${productsBase(orgId, shopId)}/${simpleId}/variants/${variantId}/activate`)
        .expect(200);
      const activated = await authed(owner)
        .post(`${productsBase(orgId, shopId)}/${simpleId}/activate`)
        .expect(200);
      expect(activated.body.status).toBe('ACTIVE');
    });

    it('dernière variante ACTIVE d’un produit ACTIVE : désactivation et archivage refusés', async () => {
      const detail = await authed(owner)
        .get(`${productsBase(orgId, shopId)}/${simpleId}`)
        .expect(200);
      const variantId = detail.body.variants[0].id;
      const deact = await authed(owner)
        .post(`${productsBase(orgId, shopId)}/${simpleId}/variants/${variantId}/deactivate`)
        .expect(409);
      expect(deact.body.code).toBe('CANNOT_ARCHIVE_LAST_ACTIVE_VARIANT');
      await authed(owner)
        .post(`${productsBase(orgId, shopId)}/${simpleId}/variants/${variantId}/archive`)
        .expect(409);
    });

    it('archivage de la variante DEFAULT : promotion transactionnelle d’une remplaçante', async () => {
      await authed(owner).post(`${productsBase(orgId, shopId)}/${multiId}/activate`).expect(200);
      const detail = await authed(owner)
        .get(`${productsBase(orgId, shopId)}/${multiId}`)
        .expect(200);
      const defaultVariant = detail.body.variants.find((v: { isDefault: boolean }) => v.isDefault);
      const archived = await authed(owner)
        .post(
          `${productsBase(orgId, shopId)}/${multiId}/variants/${defaultVariant.id}/archive`,
        )
        .expect(200);
      expect(archived.body.status).toBe('ARCHIVED');
      expect(archived.body.isDefault).toBe(false);

      const after = await authed(owner)
        .get(`${productsBase(orgId, shopId)}/${multiId}`)
        .expect(200);
      const defaults = after.body.variants.filter(
        (v: { isDefault: boolean; status: string }) => v.isDefault && v.status !== 'ARCHIVED',
      );
      expect(defaults).toHaveLength(1); // promotion effectuée, une seule DEFAULT vivante
    });

    it('suppression d’une option/valeur UTILISÉE refusée ; valeur inutilisée supprimable', async () => {
      const detail = await authed(owner)
        .get(`${productsBase(orgId, shopId)}/${multiId}`)
        .expect(200);
      const option = detail.body.options.find((o: { name: string }) => o.name === 'Taille');

      const refusedOption = await authed(owner)
        .delete(`${productsBase(orgId, shopId)}/${multiId}/options/${option.id}`)
        .expect(409);
      expect(refusedOption.body.code).toBe('OPTION_IN_USE');

      const usedValue = option.values.find((v: { value: string }) => v.value === 'M');
      await authed(owner)
        .delete(
          `${productsBase(orgId, shopId)}/${multiId}/options/${option.id}/values/${usedValue.id}`,
        )
        .expect(409);

      // Valeur ajoutée puis supprimée sans jamais être utilisée : OK.
      const withXl = await authed(owner)
        .post(`${productsBase(orgId, shopId)}/${multiId}/options/${option.id}/values`)
        .send({ value: 'XL' })
        .expect(201);
      const xl = withXl.body.options
        .find((o: { id: string }) => o.id === option.id)
        .values.find((v: { value: string }) => v.value === 'XL');
      await authed(owner)
        .delete(`${productsBase(orgId, shopId)}/${multiId}/options/${option.id}/values/${xl.id}`)
        .expect(200);
    });

    it('archivage produit : variantes archivées, stock et mouvements CONSERVÉS', async () => {
      const prodRes = await authed(owner)
        .post(productsBase(orgId, shopId))
        .send({
          name: `À archiver ${RUN_ID}`,
          variants: [{ sku: `ARCH-${RUN_ID}`, priceMinor: 100, initialQuantity: 4 }],
        })
        .expect(201);
      const variantId = prodRes.body.variants[0].id;

      const archived = await authed(owner)
        .post(`${productsBase(orgId, shopId)}/${prodRes.body.id}/archive`)
        .expect(200);
      expect(archived.body.status).toBe('ARCHIVED');
      expect(archived.body.variants[0].status).toBe('ARCHIVED');

      const movements = await prisma.inventoryMovement.count({ where: { variantId } });
      const item = await prisma.inventoryItem.findUnique({ where: { variantId } });
      expect(movements).toBe(1); // historique conservé
      expect(item?.quantityOnHand).toBe(4); // stock conservé
      // Terminal : plus modifiable.
      await authed(owner)
        .patch(`${productsBase(orgId, shopId)}/${prodRes.body.id}`)
        .send({ name: 'Interdit' })
        .expect(409);
    });
  });

  // ------------------------------------------------------------ cohérence DB

  describe('Cohérence PostgreSQL (écritures SQL directes)', () => {
    it('un produit ne peut pas référencer la catégorie d’une AUTRE Shop (FK composite)', async () => {
      const foreignCat = await prisma.productCategory.findFirstOrThrow({
        where: { shopId: shop2Id },
      });
      await expect(
        prisma.$executeRaw`
          INSERT INTO "products" ("id", "organizationId", "shopId", "categoryId", "name", "slug", "currency", "updatedAt")
          VALUES ('e2e-cross-cat', ${orgId}, ${shopId}, ${foreignCat.id}, 'Cross', 'e2e-cross-cat', 'XAF', NOW())
        `,
      ).rejects.toThrow(/foreign key/i);
    });

    it('une variante du produit A ne peut PAS être reliée à une option du produit B (chaîne FK)', async () => {
      const productA = await prisma.product.findFirstOrThrow({
        where: { shopId, options: { none: {} }, variants: { some: {} } },
        select: { variants: { take: 1, select: { id: true } } },
      });
      const optionB = await prisma.productOption.findFirstOrThrow({
        where: { shopId },
        select: { id: true, productId: true, values: { take: 1, select: { id: true } } },
      });
      const variantAId = productA.variants[0].id;

      await expect(
        prisma.$executeRaw`
          INSERT INTO "product_variant_option_values" ("variantId", "optionValueId", "optionId", "productId")
          VALUES (${variantAId}, ${optionB.values[0].id}, ${optionB.id}, ${optionB.productId})
        `,
      ).rejects.toThrow(/foreign key/i);
    });

    it('un produit d’une autre organisation est introuvable (404 anti-énumération)', async () => {
      const product = await prisma.product.findFirstOrThrow({ where: { shopId } });
      await authed(outsider)
        .get(`${productsBase(orgBId, shopBId)}/${product.id}`)
        .expect(404);
      await authed(outsider).get(productsBase(orgId, shopId)).expect(404); // org A invisible
    });
  });

  // ------------------------------------------------------------ inventaire

  describe('Inventaire', () => {
    let variantId: string;
    let productId: string;
    const invBase = () => `/api/organizations/${orgId}/shops/${shopId}`;

    beforeAll(async () => {
      const res = await authed(owner)
        .post(productsBase(orgId, shopId))
        .send({
          name: `Stock ${RUN_ID}`,
          variants: [
            { sku: `STOCK-${RUN_ID}`, priceMinor: 2000, initialQuantity: 10, lowStockThreshold: 5 },
          ],
        })
        .expect(201);
      productId = res.body.id;
      variantId = res.body.variants[0].id;
    });

    it('RESTOCK : delta POSITIF stocké, atomique', async () => {
      const res = await authed(owner)
        .post(`${invBase()}/variants/${variantId}/inventory/adjust`)
        .send({ type: 'RESTOCK', quantity: 5 })
        .expect(200);
      expect(res.body.movement).toMatchObject({
        type: 'RESTOCK',
        quantityDelta: 5,
        quantityBefore: 10,
        quantityAfter: 15,
      });
      expect(res.body.inventory.quantityOnHand).toBe(15);
    });

    it('DAMAGE : quantité positive reçue, delta NÉGATIF stocké, raison obligatoire', async () => {
      await authed(owner)
        .post(`${invBase()}/variants/${variantId}/inventory/adjust`)
        .send({ type: 'DAMAGE', quantity: 3 })
        .expect(400); // raison manquante
      const res = await authed(owner)
        .post(`${invBase()}/variants/${variantId}/inventory/adjust`)
        .send({ type: 'DAMAGE', quantity: 3, reason: 'Colis endommagé' })
        .expect(200);
      expect(res.body.movement.quantityDelta).toBe(-3);
      expect(res.body.inventory.quantityOnHand).toBe(12);
    });

    it('ADJUSTMENT : quantité cible + version, delta = after − before', async () => {
      const current = await authed(owner)
        .get(`${invBase()}/variants/${variantId}/inventory`)
        .expect(200);
      const res = await authed(owner)
        .post(`${invBase()}/variants/${variantId}/inventory/adjust`)
        .send({
          type: 'ADJUSTMENT',
          newQuantityOnHand: 4,
          expectedVersion: current.body.version,
          reason: 'Inventaire physique',
        })
        .expect(200);
      expect(res.body.movement).toMatchObject({ quantityDelta: -8, quantityBefore: 12, quantityAfter: 4 });
    });

    it('quantityOnHand ne devient JAMAIS négatif (DAMAGE trop grand → 409)', async () => {
      const res = await authed(owner)
        .post(`${invBase()}/variants/${variantId}/inventory/adjust`)
        .send({ type: 'DAMAGE', quantity: 9999, reason: 'Impossible' })
        .expect(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');
      const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId } });
      expect(item.quantityOnHand).toBeGreaterThanOrEqual(0);
    });

    it('deux RESTOCK CONCURRENTS : somme exacte, mouvements cohérents', async () => {
      const before = (await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId } }))
        .quantityOnHand;
      const [a, b] = await Promise.all([
        authed(owner)
          .post(`${invBase()}/variants/${variantId}/inventory/adjust`)
          .send({ type: 'RESTOCK', quantity: 7 }),
        authed(owner)
          .post(`${invBase()}/variants/${variantId}/inventory/adjust`)
          .send({ type: 'RESTOCK', quantity: 11 }),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      const after = (await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId } }))
        .quantityOnHand;
      expect(after).toBe(before + 18); // jamais d'écrasement

      const movements = await prisma.inventoryMovement.findMany({
        where: { variantId, type: 'RESTOCK', quantityDelta: { in: [7, 11] } },
      });
      for (const movement of movements) {
        expect(movement.quantityAfter - movement.quantityBefore).toBe(movement.quantityDelta);
      }
    });

    it('deux ADJUSTMENT avec la même version : un seul passe, l’autre 409 INVENTORY_CONCURRENCY', async () => {
      const current = await authed(owner)
        .get(`${invBase()}/variants/${variantId}/inventory`)
        .expect(200);
      const payload = (target: number) => ({
        type: 'ADJUSTMENT',
        newQuantityOnHand: target,
        expectedVersion: current.body.version,
        reason: 'Course concurrente',
      });
      const [a, b] = await Promise.all([
        authed(owner).post(`${invBase()}/variants/${variantId}/inventory/adjust`).send(payload(50)),
        authed(owner).post(`${invBase()}/variants/${variantId}/inventory/adjust`).send(payload(60)),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      const failed = a.status === 409 ? a : b;
      expect(failed.body.code).toBe('INVENTORY_CONCURRENCY');
    });

    it('backorder : available négatif SANS stock physique négatif → BACKORDERED', async () => {
      const res = await authed(owner)
        .post(productsBase(orgId, shopId))
        .send({
          name: `Backorder ${RUN_ID}`,
          variants: [
            { sku: `BACK-${RUN_ID}`, priceMinor: 1000, initialQuantity: 2, allowBackorder: true },
          ],
        })
        .expect(201);
      const backVariantId = res.body.variants[0].id;
      // Réservation simulée directement (les paniers n'existent pas encore).
      await prisma.inventoryItem.update({
        where: { variantId: backVariantId },
        data: { quantityReserved: 5 },
      });
      const inv = await authed(owner)
        .get(`${invBase()}/variants/${backVariantId}/inventory`)
        .expect(200);
      expect(inv.body.quantityOnHand).toBe(2); // jamais négatif
      expect(inv.body.quantityAvailable).toBe(-3); // available PEUT l'être
      expect(inv.body.stockStatus).toBe('BACKORDERED');
    });

    it('SERVICE : trackInventory=true refusé, aucun InventoryItem créé', async () => {
      const refused = await authed(owner)
        .post(productsBase(orgId, shopId))
        .send({
          name: 'Service impossible',
          productType: 'SERVICE',
          variants: [{ sku: `SVC-KO-${RUN_ID}`, priceMinor: 1000, trackInventory: true }],
        })
        .expect(400);
      expect(refused.body.code).toBe('VALIDATION_ERROR');

      const ok = await authed(owner)
        .post(productsBase(orgId, shopId))
        .send({
          name: `Service ${RUN_ID}`,
          productType: 'SERVICE',
          variants: [{ sku: `SVC-OK-${RUN_ID}`, priceMinor: 1000 }],
        })
        .expect(201);
      expect(ok.body.variants[0].trackInventory).toBe(false);
      expect(ok.body.variants[0].stockStatus).toBe('NOT_TRACKED');
      const item = await prisma.inventoryItem.findUnique({
        where: { variantId: ok.body.variants[0].id },
      });
      expect(item).toBeNull();
      // Ajustement refusé.
      const adj = await authed(owner)
        .post(`${invBase()}/variants/${ok.body.variants[0].id}/inventory/adjust`)
        .send({ type: 'RESTOCK', quantity: 1 })
        .expect(409);
      expect(adj.body.code).toBe('INVENTORY_NOT_TRACKED');
    });

    it('liste inventaire : filtres stock faible et rupture appliqués côté SQL', async () => {
      const low = await authed(owner)
        .get(`${invBase()}/inventory?stockStatus=LOW_STOCK&limit=50`)
        .expect(200);
      expect(low.body.items.every((row: { stockStatus: string }) => row.stockStatus === 'LOW_STOCK')).toBe(true);
      const out = await authed(owner)
        .get(`${invBase()}/inventory?stockStatus=OUT_OF_STOCK&limit=50`)
        .expect(200);
      expect(
        out.body.items.every((row: { stockStatus: string }) => row.stockStatus === 'OUT_OF_STOCK'),
      ).toBe(true);
    });

    it('mouvements : historique paginé, visible avec inventory.viewMovements', async () => {
      const res = await authed(owner)
        .get(`${invBase()}/variants/${variantId}/inventory/movements?limit=5`)
        .expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items[0]).toHaveProperty('quantityDelta');
    });

    void productId;
  });

  // ------------------------------------------------------------ liste produits

  describe('Liste produits — filtres et tris AVANT pagination (SQL)', () => {
    it('tri par prix ascendant cohérent à travers les pages', async () => {
      const page1 = await authed(owner)
        .get(`${productsBase(orgId, shopId)}?sortBy=price&sortDir=asc&limit=3&page=1`)
        .expect(200);
      const page2 = await authed(owner)
        .get(`${productsBase(orgId, shopId)}?sortBy=price&sortDir=asc&limit=3&page=2`)
        .expect(200);
      const prices = [...page1.body.items, ...page2.body.items]
        .map((item: { minPriceMinor: number | null }) => item.minPriceMinor)
        .filter((price: number | null): price is number => price !== null);
      const sorted = [...prices].sort((a, b) => a - b);
      expect(prices).toEqual(sorted); // l'ordre traverse la frontière de page
    });

    it('filtre stockStatus appliqué avant pagination (total exact, pages cohérentes)', async () => {
      const all = await authed(owner)
        .get(`${productsBase(orgId, shopId)}?limit=100`)
        .expect(200);
      const filtered = await authed(owner)
        .get(`${productsBase(orgId, shopId)}?stockStatus=IN_STOCK&limit=2&page=1`)
        .expect(200);
      const expectedTotal = all.body.items.filter(
        (item: { stockStatus: string }) => item.stockStatus === 'IN_STOCK',
      ).length;
      expect(filtered.body.total).toBe(expectedTotal);
      expect(
        filtered.body.items.every((item: { stockStatus: string }) => item.stockStatus === 'IN_STOCK'),
      ).toBe(true);
    });

    it('recherche par SKU de variante', async () => {
      const res = await authed(owner)
        .get(`${productsBase(orgId, shopId)}?search=STOCK-${RUN_ID}`)
        .expect(200);
      expect(res.body.items.length).toBe(1);
      expect(res.body.items[0].name).toBe(`Stock ${RUN_ID}`);
    });
  });

  // ------------------------------------------------------------ permissions

  describe('Permissions et blocages', () => {
    it('AGENT : lecture OK, aucune modification, costPriceMinor JAMAIS présent', async () => {
      const list = await authed(agent).get(productsBase(orgId, shopId)).expect(200);
      expect(list.body.items.length).toBeGreaterThan(0);

      const product = await prisma.product.findFirstOrThrow({
        where: { shopId, status: { not: 'ARCHIVED' } },
      });
      const detail = await authed(agent)
        .get(`${productsBase(orgId, shopId)}/${product.id}`)
        .expect(200);
      for (const variant of detail.body.variants) {
        expect(variant).not.toHaveProperty('costPriceMinor');
      }
      // …alors qu'il est présent pour l'OWNER (DTO distincts, pas un masquage CSS).
      const ownerDetail = await authed(owner)
        .get(`${productsBase(orgId, shopId)}/${product.id}`)
        .expect(200);
      expect(ownerDetail.body.variants[0]).toHaveProperty('costPriceMinor');

      await authed(agent)
        .post(productsBase(orgId, shopId))
        .send({ name: 'Interdit', variants: [{ sku: 'AGT-1', priceMinor: 1 }] })
        .expect(403);
      await authed(agent).post(categoriesBase(orgId, shopId)).send({ name: 'Interdit' }).expect(403);
      const variant = await prisma.productVariant.findFirstOrThrow({
        where: { shopId, trackInventory: true },
      });
      await authed(agent)
        .post(`/api/organizations/${orgId}/shops/${shopId}/variants/${variant.id}/inventory/adjust`)
        .send({ type: 'RESTOCK', quantity: 1 })
        .expect(403);
    });

    it('Shop archivée : écritures catalogue bloquées', async () => {
      const tmpShop = await authed(owner)
        .post(`/api/organizations/${orgId}/shops`)
        .send({ name: `Cat Tmp ${RUN_ID}`, countryCode: 'CM' })
        .expect(201);
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${tmpShop.body.id}/archive`)
        .expect(200);
      await authed(owner)
        .post(productsBase(orgId, tmpShop.body.id))
        .send({ name: 'Bloqué', variants: [{ sku: 'BLK-1', priceMinor: 1 }] })
        .expect(403);
    });

    it('Organization SUSPENDED : tout accès bloqué', async () => {
      await prisma.organization.update({ where: { id: orgId }, data: { status: 'SUSPENDED' } });
      try {
        const res = await authed(owner).get(productsBase(orgId, shopId)).expect(403);
        expect(res.body.code).toBe('ORGANIZATION_SUSPENDED');
      } finally {
        await prisma.organization.update({ where: { id: orgId }, data: { status: 'ACTIVE' } });
      }
    });

    it('aucun champ interne sensible dans les réponses (combinationKey, version produit…)', async () => {
      const product = await prisma.product.findFirstOrThrow({ where: { shopId } });
      const detail = await authed(owner)
        .get(`${productsBase(orgId, shopId)}/${product.id}`)
        .expect(200);
      for (const variant of detail.body.variants) {
        expect(variant).not.toHaveProperty('combinationKey');
      }
    });
  });
});
