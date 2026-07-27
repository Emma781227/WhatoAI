// Overrides d'environnement AVANT l'import d'AppModule.
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.AUTH_EXPOSE_TEST_TOKENS = 'true';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.ENABLE_MOCK_WHATSAPP_ENDPOINTS = 'true';
process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REGISTER_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REFRESH_MAX = '1000';
process.env.AUTH_RATE_LIMIT_RESET_MAX = '1000';
process.env.AUTH_RATE_LIMIT_FORGOT_PASSWORD_MAX = '1000';
process.env.AUTH_RATE_LIMIT_RESEND_VERIFICATION_MAX = '1000';

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Redis } from 'ioredis';
import { io as socketIo, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisIoAdapter } from '../src/realtime/redis-io.adapter';

const RUN_ID = Date.now().toString(36);
const EMAIL_PREFIX = `e2e-cart-${RUN_ID}`;
const PASSWORD = 'e2e-password-123';
const WORKER_DIST = resolve(__dirname, '../../whatsapp-worker/dist/main.js');

function email(tag: string): string {
  return `${EMAIL_PREFIX}-${tag}@e2e.whauto.test`;
}

function tokenFromDevLink(devLink: string): string {
  return new URL(devLink).searchParams.get('token')!;
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 15000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

interface TestUser {
  email: string;
  accessToken: string;
}

describe('Panier conversationnel (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;
  let apiPort: number;
  let worker: ChildProcess;

  let owner: TestUser;
  let agent: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let orgBId: string;
  let shopId: string;
  let channelId: string;
  let conversationId: string; // conversation principale
  let conversation2Id: string; // seconde conversation (concurrence dernier article)
  let teeVariantId: string; // stock 20
  let lastVariantId: string; // stock 1
  let backVariantId: string; // backorder, stock 0

  const cartBase = (org: string, conv: string) =>
    `/api/organizations/${org}/conversations/${conv}/cart`;

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
    const withAuth = (method: 'get' | 'post' | 'patch' | 'delete') => (path: string) =>
      request(server)[method](path).set('Authorization', `Bearer ${user.accessToken}`);
    return { get: withAuth('get'), post: withAuth('post'), patch: withAuth('patch'), delete: withAuth('delete') };
  }

  async function newConversation(phone: string): Promise<string> {
    await request(server)
      .post('/api/dev/whatsapp/mock/inbound')
      .send({ channelId, phone, text: 'Bonjour' })
      .expect(202);
    const conversation = await waitFor(
      () =>
        prisma.conversation.findFirst({
          where: { channelId, contact: { normalizedPhone: phone } },
          select: { id: true },
        }),
      `conversation ${phone}`,
    );
    return conversation.id;
  }

  /** Remet la conversation principale à zéro : panier terminal + stock libéré. */
  async function resetMainCart(): Promise<void> {
    const carts = await prisma.cart.findMany({
      where: { conversationId, status: { in: ['ACTIVE', 'CHECKOUT_STARTED'] } },
      select: { id: true },
    });
    for (const cart of carts) {
      const reservations = await prisma.stockReservation.findMany({
        where: { cartId: cart.id, status: 'ACTIVE' },
      });
      for (const reservation of reservations) {
        await prisma.$transaction([
          prisma.stockReservation.update({
            where: { id: reservation.id },
            data: { status: 'CANCELLED', releasedAt: new Date() },
          }),
          prisma.inventoryItem.update({
            where: { variantId: reservation.variantId },
            data: { quantityReserved: { decrement: reservation.quantity } },
          }),
        ]);
      }
      await prisma.checkoutSession.updateMany({
        where: { cartId: cart.id, status: { not: 'CONFIRMED' } },
        data: { status: 'CANCELLED' },
      });
      await prisma.cart.update({ where: { id: cart.id }, data: { status: 'ABANDONED' } });
    }
  }

  beforeAll(async () => {
    if (!existsSync(WORKER_DIST)) {
      throw new Error('Worker non buildé — pnpm --filter @whauto/whatsapp-worker build');
    }
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
    const ioAdapter = new RedisIoAdapter(app, app.get(ConfigService));
    await ioAdapter.connectToRedis();
    app.useWebSocketAdapter(ioAdapter);
    await app.init();
    await app.listen(0);
    apiPort = (app.getHttpServer().address() as { port: number }).port;
    prisma = app.get(PrismaService);
    server = app.getHttpServer();

    // Worker réel : sweep panier rapide pour les tests d'expiration.
    worker = spawn(process.execPath, [WORKER_DIST], {
      env: {
        ...process.env,
        LOG_LEVEL: 'fatal',
        CART_EXPIRATION_SWEEP_INTERVAL_SECONDS: '1',
        WHATSAPP_RECOVERY_SWEEP_INTERVAL_MS: '60000',
      },
      stdio: 'ignore',
    });

    owner = await verifiedUser('owner');
    agent = await verifiedUser('agent');
    outsider = await verifiedUser('outsider');

    const orgRes = await authed(owner)
      .post('/api/organizations')
      .send({ name: `Cart Org ${RUN_ID}`, slug: `e2e-cart-org-${RUN_ID}` })
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
      .send({ name: `Cart Shop ${RUN_ID}`, countryCode: 'CM' })
      .expect(201);
    shopId = shopRes.body.id;

    // Produits : TEE (stock 20), LAST (stock 1), BACK (backorder, stock 0).
    const products = await Promise.all([
      authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products`)
        .send({ name: `Tee ${RUN_ID}`, variants: [{ sku: `CT-TEE-${RUN_ID}`, priceMinor: 5000, initialQuantity: 20 }] }),
      authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products`)
        .send({ name: `Last ${RUN_ID}`, variants: [{ sku: `CT-LAST-${RUN_ID}`, priceMinor: 9000, initialQuantity: 1 }] }),
      authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products`)
        .send({
          name: `Back ${RUN_ID}`,
          variants: [{ sku: `CT-BACK-${RUN_ID}`, priceMinor: 3000, initialQuantity: 0, allowBackorder: true }],
        }),
    ]);
    for (const res of products) {
      expect(res.status).toBe(201);
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products/${res.body.id}/activate`)
        .expect(200);
    }
    teeVariantId = products[0].body.variants[0].id;
    lastVariantId = products[1].body.variants[0].id;
    backVariantId = products[2].body.variants[0].id;

    const chanRes = await authed(owner)
      .post(`/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/mock`)
      .send({ displayName: 'Cart WA', phoneNumber: '+237659000001' })
      .expect(201);
    channelId = chanRes.body.id;
    conversationId = await newConversation('+237659100001');
    conversation2Id = await newConversation('+237659100002');

    const orgBRes = await authed(outsider)
      .post('/api/organizations')
      .send({ name: `Cart Org B ${RUN_ID}`, slug: `e2e-cart-orgb-${RUN_ID}` })
      .expect(201);
    orgBId = orgBRes.body.organization.id;
  }, 180000);

  afterAll(async () => {
    worker?.kill();
    await app?.close();
  });

  // ------------------------------------------------------------------- cart

  describe('Cycle de vie du panier', () => {
    it('GET sans panier → 404 ; premier ajout CRÉE le panier + audit', async () => {
      await authed(owner).get(cartBase(orgId, conversationId)).expect(404);

      const res = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/items`)
        .send({ variantId: teeVariantId, quantity: 1, clientMutationId: `add-${RUN_ID}-1` })
        .expect(201);
      expect(res.body.status).toBe('ACTIVE');
      expect(res.body.items).toHaveLength(1);
      expect(res.body.subtotalMinor).toBe(5000);
      expect(res.body.items[0].productName).toContain('Tee'); // snapshot descriptif

      const audit = await prisma.organizationAuditEvent.findFirst({
        where: { organizationId: orgId, eventType: 'CART_CREATED' },
      });
      expect(audit).not.toBeNull();
    });

    it('un SEUL panier ouvert par conversation (POST idempotent + index partiel)', async () => {
      const first = await authed(owner).post(cartBase(orgId, conversationId)).expect(201);
      const second = await authed(owner).post(cartBase(orgId, conversationId)).expect(201);
      expect(second.body.id).toBe(first.body.id);

      await expect(
        prisma.cart.create({
          data: {
            organizationId: orgId,
            shopId,
            contactId: first.body.contactId,
            conversationId,
            currency: 'XAF',
          },
        }),
      ).rejects.toThrow(); // index partiel carts_one_open_per_conversation
    });

    it('ajouter la MÊME variante incrémente la quantité ; totaux serveur recalculés', async () => {
      const res = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/items`)
        .send({ variantId: teeVariantId, quantity: 2, clientMutationId: `add-${RUN_ID}-2` })
        .expect(201);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].quantity).toBe(3);
      expect(res.body.subtotalMinor).toBe(15000);
      expect(res.body.itemCount).toBe(3);
    });

    it('DOUBLE mutation avec le même clientMutationId : AUCUN double effet', async () => {
      const mutationId = `dup-${RUN_ID}`;
      const payload = { variantId: teeVariantId, quantity: 1, clientMutationId: mutationId };
      await authed(owner).post(`${cartBase(orgId, conversationId)}/items`).send(payload).expect(201);
      const replay = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/items`)
        .send(payload)
        .expect(201);
      expect(replay.body.items[0].quantity).toBe(4); // 3 + 1, PAS 3 + 2
    });

    it('expectedVersion périmée → 409 CART_CONCURRENCY', async () => {
      const cart = await authed(owner).get(cartBase(orgId, conversationId)).expect(200);
      const res = await authed(owner)
        .patch(`${cartBase(orgId, conversationId)}/items/${cart.body.items[0].id}`)
        .send({ quantity: 2, expectedVersion: cart.body.version - 1 })
        .expect(409);
      expect(res.body.code).toBe('CART_CONCURRENCY');
    });

    it('modifier la quantité, retirer, vider — totaux exacts à chaque étape', async () => {
      let cart = await authed(owner).get(cartBase(orgId, conversationId)).expect(200);
      cart = await authed(owner)
        .patch(`${cartBase(orgId, conversationId)}/items/${cart.body.items[0].id}`)
        .send({ quantity: 2, expectedVersion: cart.body.version })
        .expect(200);
      expect(cart.body.subtotalMinor).toBe(10000);

      cart = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/items`)
        .send({ variantId: backVariantId, quantity: 1 })
        .expect(201);
      expect(cart.body.items).toHaveLength(2);

      cart = await authed(owner)
        .delete(`${cartBase(orgId, conversationId)}/items/${cart.body.items[1].id}`)
        .send({ expectedVersion: cart.body.version })
        .expect(200);
      expect(cart.body.items).toHaveLength(1);

      cart = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/clear`)
        .send({ expectedVersion: cart.body.version })
        .expect(200);
      expect(cart.body.items).toHaveLength(0);
      expect(cart.body.subtotalMinor).toBe(0);
    });

    it('aucun total accepté du body (whitelist stricte → 400)', async () => {
      await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/items`)
        .send({ variantId: teeVariantId, quantity: 1, subtotalMinor: 1 })
        .expect(400);
      await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/clear`)
        .send({ totalMinor: 0 })
        .expect(400);
    });

    it('produit inactif / variante inactive / devise étrangère refusés', async () => {
      // Produit désactivé.
      const tmp = await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products`)
        .send({ name: `Tmp ${RUN_ID}`, variants: [{ sku: `CT-TMP-${RUN_ID}`, priceMinor: 100 }] })
        .expect(201);
      const refused = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/items`)
        .send({ variantId: tmp.body.variants[0].id, quantity: 1 })
        .expect(409);
      expect(refused.body.code).toBe('CART_PRODUCT_UNAVAILABLE');

      // Devise divergente (simulée en direct — impossible via l'API, devise immuable).
      await prisma.product.update({ where: { id: tmp.body.id }, data: { status: 'ACTIVE', currency: 'EUR' } });
      const mismatch = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/items`)
        .send({ variantId: tmp.body.variants[0].id, quantity: 1 })
        .expect(409);
      expect(mismatch.body.code).toBe('CART_CURRENCY_MISMATCH');
    });
  });

  // ------------------------------------------------------------ revalidation

  describe('Revalidation', () => {
    let itemId: string;

    beforeAll(async () => {
      const cart = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/items`)
        .send({ variantId: teeVariantId, quantity: 2 })
        .expect(201);
      itemId = cart.body.items.find((i: { variantId: string }) => i.variantId === teeVariantId).id;
    });

    it('prix modifié détecté (PRICE_CHANGED) — JAMAIS corrigé silencieusement', async () => {
      const variant = await prisma.productVariant.findUniqueOrThrow({
        where: { id: teeVariantId },
        select: { productId: true },
      });
      await authed(owner)
        .patch(
          `/api/organizations/${orgId}/shops/${shopId}/products/${variant.productId}/variants/${teeVariantId}`,
        )
        .send({ priceMinor: 6000 })
        .expect(200);

      const revalidation = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/revalidate`)
        .expect(200);
      const line = revalidation.body.lines.find((l: { cartItemId: string }) => l.cartItemId === itemId);
      expect(line.status).toBe('PRICE_CHANGED');
      // Le snapshot n'a PAS bougé.
      const cart = await authed(owner).get(cartBase(orgId, conversationId)).expect(200);
      expect(cart.body.items.find((i: { id: string }) => i.id === itemId).unitPriceMinor).toBe(5000);
    });

    it('accept-current-price : résolution EXPLICITE + totaux recalculés + audit', async () => {
      const cart = await authed(owner).get(cartBase(orgId, conversationId)).expect(200);
      const accepted = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/items/${itemId}/accept-current-price`)
        .send({ expectedVersion: cart.body.version })
        .expect(200);
      const line = accepted.body.items.find((i: { id: string }) => i.id === itemId);
      expect(line.unitPriceMinor).toBe(6000);
      expect(line.availabilityStatus).toBe('VALID');
      expect(accepted.body.subtotalMinor).toBe(6000 * line.quantity);
    });

    it('rupture détectée ; backorder accepté', async () => {
      // Vider le stock TEE : rupture.
      const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/variants/${teeVariantId}/inventory/adjust`)
        .send({ type: 'ADJUSTMENT', newQuantityOnHand: 0, expectedVersion: item.version, reason: 'Test rupture' })
        .expect(200);
      const revalidation = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/revalidate`)
        .expect(200);
      expect(
        revalidation.body.lines.find((l: { cartItemId: string }) => l.cartItemId === itemId).status,
      ).toBe('OUT_OF_STOCK');
      // Restaurer.
      const item2 = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/variants/${teeVariantId}/inventory/adjust`)
        .send({ type: 'ADJUSTMENT', newQuantityOnHand: 20, expectedVersion: item2.version, reason: 'Restore' })
        .expect(200);

      // Backorder : ajout au-delà du stock accepté.
      const backCart = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/items`)
        .send({ variantId: backVariantId, quantity: 5 })
        .expect(201);
      const backLine = backCart.body.items.find(
        (i: { variantId: string }) => i.variantId === backVariantId,
      );
      expect(backLine.quantity).toBe(5);
    });
  });

  // ------------------------------------------------------------- checkout

  describe('Checkout + réservations', () => {
    beforeAll(async () => {
      await resetMainCart();
      // Panier propre : TEE ×2 + BACK ×1.
      await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/items`)
        .send({ variantId: teeVariantId, quantity: 2 })
        .expect(201);
      await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/items`)
        .send({ variantId: backVariantId, quantity: 1 })
        .expect(201);
    });

    it('start : réservations créées, quantityReserved incrémenté, mouvements RESERVATION (delta onHand = 0)', async () => {
      const before = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      const res = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/checkout/start`)
        .send({ clientMutationId: `start-${RUN_ID}` })
        .expect(200);
      expect(res.body.status).toBe('CHECKOUT_STARTED');
      expect(res.body.checkout.status).toBe('COLLECTING_INFORMATION');
      expect(res.body.checkout.customerPhone).toBe('+237659100001'); // prérempli Contact
      expect(res.body.reservationExpiresAt).not.toBeNull();

      const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      expect(after.quantityReserved).toBe(before.quantityReserved + 2);

      const movement = await prisma.inventoryMovement.findFirst({
        where: { variantId: teeVariantId, type: 'RESERVATION' },
        orderBy: { createdAt: 'desc' },
      });
      expect(movement).toMatchObject({ quantityDelta: 0 });
      expect(movement!.quantityBefore).toBe(movement!.quantityAfter); // onHand inchangé
      expect(movement!.quantityReservedAfter! - movement!.quantityReservedBefore!).toBe(2);
    });

    it('quantité AUGMENTÉE pendant le checkout : seule la DIFFÉRENCE est réservée', async () => {
      const cart = await authed(owner).get(cartBase(orgId, conversationId)).expect(200);
      const teeLine = cart.body.items.find((i: { variantId: string }) => i.variantId === teeVariantId);
      const before = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });

      const updated = await authed(owner)
        .patch(`${cartBase(orgId, conversationId)}/items/${teeLine.id}`)
        .send({ quantity: 4, expectedVersion: cart.body.version })
        .expect(200);
      expect(updated.body.items.find((i: { id: string }) => i.id === teeLine.id).reservation.quantity).toBe(4);

      const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      expect(after.quantityReserved).toBe(before.quantityReserved + 2); // +2, pas +4
    });

    it('quantité RÉDUITE : libère uniquement la différence, même transaction', async () => {
      const cart = await authed(owner).get(cartBase(orgId, conversationId)).expect(200);
      const teeLine = cart.body.items.find((i: { variantId: string }) => i.variantId === teeVariantId);
      const before = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });

      await authed(owner)
        .patch(`${cartBase(orgId, conversationId)}/items/${teeLine.id}`)
        .send({ quantity: 1, expectedVersion: cart.body.version })
        .expect(200);
      const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      expect(after.quantityReserved).toBe(before.quantityReserved - 3);
      const release = await prisma.inventoryMovement.findFirst({
        where: { variantId: teeVariantId, type: 'RELEASE' },
        orderBy: { createdAt: 'desc' },
      });
      expect(release!.quantityReservedBefore! - release!.quantityReservedAfter!).toBe(3);
    });

    it('checkout DELIVERY incomplet refusé au confirm ; PICKUP valide confirme', async () => {
      let cart = await authed(owner).get(cartBase(orgId, conversationId)).expect(200);
      // DELIVERY sans ville → incomplete au confirm.
      cart = await authed(owner)
        .patch(`${cartBase(orgId, conversationId)}/checkout`)
        .send({ expectedVersion: cart.body.checkout.version, fulfillmentType: 'DELIVERY', customerName: 'Awa' })
        .expect(200);
      expect(cart.body.checkout.status).toBe('COLLECTING_INFORMATION');
      const incomplete = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/checkout/confirm`)
        .send({ expectedVersion: cart.body.checkout.version })
        .expect(422);
      expect(incomplete.body.code).toBe('CHECKOUT_INCOMPLETE');

      // PICKUP : nom + téléphone suffisent → READY puis CONFIRMED.
      cart = await authed(owner)
        .patch(`${cartBase(orgId, conversationId)}/checkout`)
        .send({
          expectedVersion: cart.body.checkout.version,
          fulfillmentType: 'PICKUP',
          paymentPreference: 'PAY_IN_STORE',
        })
        .expect(200);
      expect(cart.body.checkout.status).toBe('READY_FOR_CONFIRMATION');

      const confirmed = await authed(owner)
        .post(`${cartBase(orgId, conversationId)}/checkout/confirm`)
        .send({ expectedVersion: cart.body.checkout.version, clientMutationId: `confirm-${RUN_ID}` })
        .expect(200);
      expect(confirmed.body.checkout.status).toBe('CONFIRMED');

      // Snapshot IMMUABLE — produit UNIQUEMENT depuis les données serveur.
      const snapshot = confirmed.body.checkout.confirmationSnapshot;
      expect(snapshot.cartId).toBe(confirmed.body.id);
      expect(snapshot.currency).toBe('XAF');
      expect(snapshot.subtotalMinor).toBe(confirmed.body.subtotalMinor);
      expect(snapshot.fulfillmentType).toBe('PICKUP');
      expect(snapshot.lines.length).toBe(confirmed.body.items.length);
      expect(snapshot.reservations.length).toBeGreaterThan(0);
    });

    it('après CONFIRMED : panier et checkout NON modifiables', async () => {
      const cart = await authed(owner).get(cartBase(orgId, conversationId)).expect(200);
      const res = await authed(owner)
        .patch(`${cartBase(orgId, conversationId)}/items/${cart.body.items[0].id}`)
        .send({ quantity: 5, expectedVersion: cart.body.version })
        .expect(409);
      expect(res.body.code).toBe('CHECKOUT_ALREADY_CONFIRMED');
      await authed(owner)
        .patch(`${cartBase(orgId, conversationId)}/checkout`)
        .send({ expectedVersion: cart.body.checkout.version, customerName: 'Interdit' })
        .expect(409);
      // Les réservations sont CONSERVÉES (en attente de conversion en Order).
      const reservations = await prisma.stockReservation.count({
        where: { cartId: cart.body.id, status: 'ACTIVE' },
      });
      expect(reservations).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------- concurrence

  describe('Concurrence sur le dernier article', () => {
    let conv3Id: string;

    beforeAll(async () => {
      conv3Id = await newConversation('+237659100003');
      // Deux paniers avec le DERNIER article (stock 1).
      await authed(owner)
        .post(`${cartBase(orgId, conversation2Id)}/items`)
        .send({ variantId: lastVariantId, quantity: 1 })
        .expect(201);
      await authed(owner)
        .post(`${cartBase(orgId, conv3Id)}/items`)
        .send({ variantId: lastVariantId, quantity: 1 })
        .expect(201);
    });

    it('deux starts concurrents : UN SEUL réserve, l’autre échoue TOUT-OU-RIEN, quantityReserved = 1', async () => {
      const [a, b] = await Promise.all([
        authed(owner).post(`${cartBase(orgId, conversation2Id)}/checkout/start`).send({}),
        authed(owner).post(`${cartBase(orgId, conv3Id)}/checkout/start`).send({}),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      const failed = a.status === 409 ? a : b;
      expect(failed.body.code).toBe('STOCK_RESERVATION_FAILED');

      const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: lastVariantId } });
      expect(item.quantityReserved).toBe(1); // jamais 2, jamais 0
      expect(item.quantityOnHand).toBe(1); // stock physique intact
      // Le perdant n'a AUCUNE réservation (tout-ou-rien).
      const loserConv = a.status === 409 ? conversation2Id : conv3Id;
      const loserCart = await prisma.cart.findFirstOrThrow({
        where: { conversationId: loserConv, status: 'ACTIVE' },
      });
      expect(await prisma.stockReservation.count({ where: { cartId: loserCart.id } })).toBe(0);
    });

    it('cancel : release complet, cart → ACTIVE, historique conservé ; abandon ensuite = zéro double décrément', async () => {
      const winnerConv = (await prisma.cart.findFirst({
        where: { conversationId: conversation2Id, status: 'CHECKOUT_STARTED' },
      }))
        ? conversation2Id
        : conv3Id;

      const cancelled = await authed(owner)
        .post(`${cartBase(orgId, winnerConv)}/checkout/cancel`)
        .expect(200);
      expect(cancelled.body.status).toBe('ACTIVE');

      const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: lastVariantId } });
      expect(item.quantityReserved).toBe(0);
      const history = await prisma.stockReservation.findMany({
        where: { variantId: lastVariantId, status: 'CANCELLED' },
      });
      expect(history.length).toBeGreaterThan(0); // historique conservé

      // Abandon après release : idempotent, reserved reste 0.
      await authed(owner)
        .post(`${cartBase(orgId, winnerConv)}/abandon`)
        .send({})
        .expect(200);
      const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: lastVariantId } });
      expect(after.quantityReserved).toBe(0);
    });

    it('plusieurs réservations HISTORIQUES par ligne, une seule ACTIVE garantie en base', async () => {
      const conv = await newConversation('+237659100004');
      await authed(owner)
        .post(`${cartBase(orgId, conv)}/items`)
        .send({ variantId: lastVariantId, quantity: 1 })
        .expect(201);
      // Cycle 1 : start puis cancel. Cycle 2 : start.
      await authed(owner).post(`${cartBase(orgId, conv)}/checkout/start`).send({}).expect(200);
      await authed(owner).post(`${cartBase(orgId, conv)}/checkout/cancel`).expect(200);
      await authed(owner).post(`${cartBase(orgId, conv)}/checkout/start`).send({}).expect(200);

      const cart = await prisma.cart.findFirstOrThrow({
        where: { conversationId: conv, status: 'CHECKOUT_STARTED' },
        select: { id: true, items: { select: { id: true } } },
      });
      const itemId = cart.items[0].id;
      const all = await prisma.stockReservation.findMany({ where: { cartItemId: itemId } });
      expect(all.length).toBe(2); // un cycle = une ligne, jamais réutilisée
      expect(all.filter((r) => r.status === 'ACTIVE')).toHaveLength(1);

      // Index partiel : une seconde ACTIVE pour la même ligne est IMPOSSIBLE en SQL direct.
      await expect(
        prisma.$executeRaw`
          INSERT INTO "stock_reservations" ("id", "organizationId", "shopId", "cartId", "cartItemId", "variantId", "quantity", "status", "expiresAt", "maxExpiresAt", "updatedAt")
          VALUES ('e2e-dup-active', ${orgId}, ${shopId}, ${cart.id}, ${itemId}, ${lastVariantId}, 1, 'ACTIVE', NOW() + interval '10 minutes', NOW() + interval '60 minutes', NOW())
        `,
      ).rejects.toThrow();

      // Nettoyage : cancel pour libérer LAST.
      await authed(owner).post(`${cartBase(orgId, conv)}/checkout/cancel`).expect(200);
    });
  });

  // ------------------------------------------------------------ expiration

  describe('Expiration (sweep worker réel)', () => {
    it('réservation expirée : release atomique + Cart → ACTIVE, checkout et données conservés', async () => {
      const conv = await newConversation('+237659100005');
      await authed(owner)
        .post(`${cartBase(orgId, conv)}/items`)
        .send({ variantId: teeVariantId, quantity: 1 })
        .expect(201);
      await authed(owner).post(`${cartBase(orgId, conv)}/checkout/start`).send({}).expect(200);
      const before = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });

      // Expiration forcée (le sweep tourne toutes les 1 s dans ce test).
      const cart = await prisma.cart.findFirstOrThrow({
        where: { conversationId: conv, status: 'CHECKOUT_STARTED' },
      });
      await prisma.stockReservation.updateMany({
        where: { cartId: cart.id, status: 'ACTIVE' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await waitFor(async () => {
        const row = await prisma.cart.findUniqueOrThrow({ where: { id: cart.id } });
        return row.status === 'ACTIVE' ? row : null;
      }, 'cart revenu ACTIVE après expiration');

      const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      expect(after.quantityReserved).toBe(before.quantityReserved - 1);
      const reservation = await prisma.stockReservation.findFirstOrThrow({ where: { cartId: cart.id } });
      expect(reservation.status).toBe('EXPIRED');
      // CheckoutSession conservée (données client non perdues — validé D8).
      const checkout = await prisma.checkoutSession.findUniqueOrThrow({ where: { cartId: cart.id } });
      expect(['COLLECTING_INFORMATION', 'READY_FOR_CONFIRMATION']).toContain(checkout.status);
    });

    it('panier inactif expiré par le sweep : EXPIRED + release + audit CART_EXPIRED', async () => {
      const conv = await newConversation('+237659100006');
      await authed(owner)
        .post(`${cartBase(orgId, conv)}/items`)
        .send({ variantId: teeVariantId, quantity: 1 })
        .expect(201);
      const cart = await prisma.cart.findFirstOrThrow({
        where: { conversationId: conv, status: 'ACTIVE' },
      });
      await prisma.cart.update({
        where: { id: cart.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await waitFor(async () => {
        const row = await prisma.cart.findUniqueOrThrow({ where: { id: cart.id } });
        return row.status === 'EXPIRED' ? row : null;
      }, 'panier expiré par le sweep');

      const audit = await prisma.organizationAuditEvent.findFirst({
        where: { organizationId: orgId, eventType: 'CART_EXPIRED' },
      });
      expect(audit).not.toBeNull();
    });

    it('confirmation refusée si les réservations expirent pendant l’opération', async () => {
      const conv = await newConversation('+237659100007');
      await authed(owner)
        .post(`${cartBase(orgId, conv)}/items`)
        .send({ variantId: teeVariantId, quantity: 1 })
        .expect(201);
      let cart = await authed(owner).post(`${cartBase(orgId, conv)}/checkout/start`).send({}).expect(200);
      cart = await authed(owner)
        .patch(`${cartBase(orgId, conv)}/checkout`)
        .send({
          expectedVersion: cart.body.checkout.version,
          fulfillmentType: 'PICKUP',
          customerName: 'Awa',
        })
        .expect(200);

      // Expire la réservation SANS laisser le sweep repasser le cart à ACTIVE
      // (course réelle : la vérification du confirm doit la détecter seule).
      await prisma.stockReservation.updateMany({
        where: { cartId: cart.body.id, status: 'ACTIVE' },
        data: { expiresAt: new Date(Date.now() - 100) },
      });
      const res = await authed(owner)
        .post(`${cartBase(orgId, conv)}/checkout/confirm`)
        .send({ expectedVersion: cart.body.checkout.version })
        .expect(409);
      expect(['STOCK_RESERVATION_EXPIRED', 'CART_NOT_ACTIVE']).toContain(res.body.code);
    });
  });

  // ------------------------------------------------------- résumé + isolation

  describe('Résumé, isolation, permissions', () => {
    it('summary-text : texte serveur revalidé + cartVersion + warnings', async () => {
      const conv = await newConversation('+237659100008');
      await authed(owner)
        .post(`${cartBase(orgId, conv)}/items`)
        .send({ variantId: backVariantId, quantity: 2 })
        .expect(201);
      const summary = await authed(owner).get(`${cartBase(orgId, conv)}/summary-text`).expect(200);
      expect(summary.body.text).toContain('Votre panier :');
      expect(summary.body.text).toContain(`Back ${RUN_ID} × 2`);
      expect(summary.body.text).toContain('Livraison : à définir');
      expect(summary.body.isRevalidated).toBe(true);
      expect(typeof summary.body.cartVersion).toBe('number');
    });

    it('cohérence DB : un Cart ne peut PAS relier une Conversation d’une autre Shop (FK composite, SQL direct)', async () => {
      const shop2 = await authed(owner)
        .post(`/api/organizations/${orgId}/shops`)
        .send({ name: `Cart Shop 2 ${RUN_ID}`, countryCode: 'CM' })
        .expect(201);
      // Conversation FRAÎCHE sans panier : seule la FK composite peut refuser
      // (pas d'interférence avec l'index partiel "un panier ouvert").
      const freshConv = await newConversation('+237659100010');
      const contact = await prisma.contact.findFirstOrThrow({ where: { shopId } });
      await expect(
        prisma.$executeRaw`
          INSERT INTO "carts" ("id", "organizationId", "shopId", "contactId", "conversationId", "currency", "updatedAt")
          VALUES ('e2e-cross-cart', ${orgId}, ${shop2.body.id}, ${contact.id}, ${freshConv}, 'XAF', NOW())
        `,
      ).rejects.toThrow(/foreign key/i);
    });

    it('panier étranger inaccessible (404 anti-énumération)', async () => {
      await authed(outsider).get(cartBase(orgBId, conversationId)).expect(404);
      await authed(outsider).get(cartBase(orgId, conversationId)).expect(404);
    });

    it('AGENT : parcours complet autorisé ; diagnostic réservations 403', async () => {
      const conv = await newConversation('+237659100009');
      let cart = await authed(agent)
        .post(`${cartBase(orgId, conv)}/items`)
        .send({ variantId: teeVariantId, quantity: 1 })
        .expect(201);
      cart = await authed(agent).post(`${cartBase(orgId, conv)}/checkout/start`).send({}).expect(200);
      cart = await authed(agent)
        .patch(`${cartBase(orgId, conv)}/checkout`)
        .send({
          expectedVersion: cart.body.checkout.version,
          fulfillmentType: 'PICKUP',
          customerName: 'Client Agent',
        })
        .expect(200);
      const confirmed = await authed(agent)
        .post(`${cartBase(orgId, conv)}/checkout/confirm`)
        .send({ expectedVersion: cart.body.checkout.version })
        .expect(200);
      expect(confirmed.body.checkout.status).toBe('CONFIRMED');
      // L'AGENT voit le résumé de réservation dans le Cart…
      expect(confirmed.body.reservationExpiresAt).not.toBeNull();
      // …mais pas le diagnostic technique.
      await authed(agent).get(`${cartBase(orgId, conv)}/reservations`).expect(403);
      await authed(owner).get(`${cartBase(orgId, conv)}/reservations`).expect(200);
    });

    it('Shop archivée : écritures panier bloquées ; Organization SUSPENDED : tout bloqué', async () => {
      await prisma.shop.update({ where: { id: shopId }, data: { status: 'ARCHIVED' } });
      try {
        await authed(owner)
          .post(`${cartBase(orgId, conversationId)}/items`)
          .send({ variantId: teeVariantId, quantity: 1 })
          .expect(403);
      } finally {
        await prisma.shop.update({ where: { id: shopId }, data: { status: 'ACTIVE' } });
      }
      await prisma.organization.update({ where: { id: orgId }, data: { status: 'SUSPENDED' } });
      try {
        const res = await authed(owner).get(cartBase(orgId, conversationId)).expect(403);
        expect(res.body.code).toBe('ORGANIZATION_SUSPENDED');
      } finally {
        await prisma.organization.update({ where: { id: orgId }, data: { status: 'ACTIVE' } });
      }
    });

    it('événements Socket.IO uniquement dans la bonne organisation', async () => {
      function connect(token: string): Promise<ClientSocket> {
        return new Promise((resolvePromise, reject) => {
          const socket = socketIo(`http://localhost:${apiPort}`, {
            auth: { token },
            transports: ['websocket'],
            reconnection: false,
          });
          socket.on('connect', () => resolvePromise(socket));
          socket.on('connect_error', reject);
          setTimeout(() => reject(new Error('socket timeout')), 5000);
        });
      }
      const socketA = await connect(owner.accessToken);
      const socketB = await connect(outsider.accessToken);
      await socketA.emitWithAck('subscribe:organization', { organizationId: orgId });
      await socketB.emitWithAck('subscribe:organization', { organizationId: orgBId });
      const receivedA: unknown[] = [];
      const receivedB: unknown[] = [];
      socketA.on('cart.updated', (payload) => receivedA.push(payload));
      socketB.on('cart.updated', (payload) => receivedB.push(payload));

      // Conversation fraîche : le panier de la principale est confirmé (gelé).
      const socketConv = await newConversation('+237659100011');
      await authed(owner)
        .post(`${cartBase(orgId, socketConv)}/items`)
        .send({ variantId: teeVariantId, quantity: 1 })
        .expect(201);
      await waitFor(() => Promise.resolve(receivedA.length > 0 ? receivedA : null), 'événement cart org A');
      await new Promise((r) => setTimeout(r, 400));

      expect(receivedA.length).toBeGreaterThan(0);
      // Payload = RÉFÉRENCES + version uniquement (validé D14).
      const payload = receivedA[0] as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(
        ['cartId', 'cartVersion', 'conversationId', 'organizationId', 'shopId'].sort(),
      );
      expect(receivedB).toHaveLength(0);
      socketA.close();
      socketB.close();
    });
  });

  // ------------------------------------------------------------- invariants

  describe('Invariants PostgreSQL finaux', () => {
    it('quantityReserved = Σ réservations ACTIVE ; aucun orphelin ; totaux cohérents', async () => {
      const rows = await prisma.$queryRaw<Array<{ variantId: string; reserved: number; active: bigint }>>`
        SELECT i."variantId", i."quantityReserved" AS reserved,
               COALESCE((SELECT SUM(r."quantity") FROM "stock_reservations" r
                         WHERE r."variantId" = i."variantId" AND r."status" = 'ACTIVE'), 0)::bigint AS active
        FROM "inventory_items" i
        WHERE i."shopId" = ${shopId}
      `;
      for (const row of rows) {
        expect(Number(row.active)).toBe(row.reserved);
      }
      const orphans = await prisma.stockReservation.count({
        where: { status: 'ACTIVE', cart: { status: { in: ['CONVERTED', 'ABANDONED', 'EXPIRED'] } } },
      });
      expect(orphans).toBe(0);
      const badTotals = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT c."id" FROM "carts" c
        WHERE c."subtotalMinor" <> COALESCE((SELECT SUM(ci."lineSubtotalMinor") FROM "cart_items" ci WHERE ci."cartId" = c."id"), 0)
      `;
      expect(badTotals).toHaveLength(0);
      const negative = await prisma.inventoryItem.count({ where: { quantityOnHand: { lt: 0 } } });
      expect(negative).toBe(0);
    });
  });
});
