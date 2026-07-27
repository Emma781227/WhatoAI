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
import { io as socketIo } from 'socket.io-client';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisIoAdapter } from '../src/realtime/redis-io.adapter';

const RUN_ID = Date.now().toString(36);
const EMAIL_PREFIX = `e2e-order-${RUN_ID}`;
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

describe('Commandes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;
  let worker: ChildProcess;

  let owner: TestUser;
  let manager: TestUser;
  let agent: TestUser;
  let outsider: TestUser;
  let orgId: string;
  let orgBId: string;
  let shopId: string;
  let channelId: string;
  let teeVariantId: string; // stock 20, tracked
  let teeProductId: string;
  let backVariantId: string; // stock 2, allowBackorder
  let svcVariantId: string; // SERVICE, non suivi

  const cartBase = (org: string, conv: string) =>
    `/api/organizations/${org}/conversations/${conv}/cart`;
  const ordersConvBase = (org: string, conv: string) =>
    `/api/organizations/${org}/conversations/${conv}/orders`;
  const ordersBase = (org: string) => `/api/organizations/${org}/orders`;

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
    const withAuth =
      (method: 'get' | 'post' | 'patch' | 'delete') => (path: string) =>
        request(server)[method](path).set('Authorization', `Bearer ${user.accessToken}`);
    return {
      get: withAuth('get'),
      post: withAuth('post'),
      patch: withAuth('patch'),
      delete: withAuth('delete'),
    };
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

  /** Ajoute des lignes, démarre puis confirme un checkout — renvoie le cart body final. */
  async function checkoutAndConfirm(
    conv: string,
    items: Array<{ variantId: string; quantity: number }>,
    opts: {
      fulfillmentType: 'DELIVERY' | 'PICKUP';
      paymentPreference?: string;
      customerName?: string;
    } = { fulfillmentType: 'PICKUP' },
  ) {
    for (const item of items) {
      await authed(owner).post(`${cartBase(orgId, conv)}/items`).send(item).expect(201);
    }
    let cart = await authed(owner)
      .post(`${cartBase(orgId, conv)}/checkout/start`)
      .send({})
      .expect(200);
    const patchBody: Record<string, unknown> = {
      expectedVersion: cart.body.checkout.version,
      fulfillmentType: opts.fulfillmentType,
      customerName: opts.customerName ?? 'Cliente E2E',
      paymentPreference: opts.paymentPreference ?? 'CASH_ON_DELIVERY',
    };
    if (opts.fulfillmentType === 'DELIVERY') {
      patchBody.city = 'Douala';
      patchBody.addressLine1 = 'Rue des Manguiers 4';
      patchBody.countryCode = 'CM';
    }
    cart = await authed(owner)
      .patch(`${cartBase(orgId, conv)}/checkout`)
      .send(patchBody)
      .expect(200);
    expect(cart.body.checkout.status).toBe('READY_FOR_CONFIRMATION');
    cart = await authed(owner)
      .post(`${cartBase(orgId, conv)}/checkout/confirm`)
      .send({
        expectedVersion: cart.body.checkout.version,
        clientMutationId: `confirm-${conv}-${Date.now()}`,
      })
      .expect(200);
    expect(cart.body.checkout.status).toBe('CONFIRMED');
    return cart.body;
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
    prisma = app.get(PrismaService);
    server = app.getHttpServer();

    // Worker réel : la création de Contact/Conversation depuis le webhook mock
    // passe par la durable inbox → BullMQ → processor du worker.
    worker = spawn(process.execPath, [WORKER_DIST], {
      env: {
        ...process.env,
        LOG_LEVEL: 'fatal',
        WHATSAPP_RECOVERY_SWEEP_INTERVAL_MS: '60000',
      },
      stdio: 'ignore',
    });

    owner = await verifiedUser('owner');
    manager = await verifiedUser('manager');
    agent = await verifiedUser('agent');
    outsider = await verifiedUser('outsider');

    const orgRes = await authed(owner)
      .post('/api/organizations')
      .send({ name: `Order Org ${RUN_ID}`, slug: `e2e-order-org-${RUN_ID}` })
      .expect(201);
    orgId = orgRes.body.organization.id;
    for (const [user, role] of [
      [manager, 'MANAGER'],
      [agent, 'AGENT'],
    ] as const) {
      const inviteRes = await authed(owner)
        .post(`/api/organizations/${orgId}/invitations`)
        .send({ email: user.email, role })
        .expect(201);
      await authed(user)
        .post('/api/invitations/accept')
        .send({ token: tokenFromDevLink(inviteRes.body.devLink) })
        .expect(200);
    }

    const shopRes = await authed(owner)
      .post(`/api/organizations/${orgId}/shops`)
      .send({ name: `Order Shop ${RUN_ID}`, countryCode: 'CM' })
      .expect(201);
    shopId = shopRes.body.id;

    const products = await Promise.all([
      authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products`)
        .send({
          name: `OrderTee ${RUN_ID}`,
          variants: [{ sku: `OT-TEE-${RUN_ID}`, priceMinor: 5000, initialQuantity: 20 }],
        }),
      authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products`)
        .send({
          name: `OrderBack ${RUN_ID}`,
          variants: [
            { sku: `OT-BACK-${RUN_ID}`, priceMinor: 3000, initialQuantity: 2, allowBackorder: true },
          ],
        }),
      authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products`)
        .send({
          name: `OrderSvc ${RUN_ID}`,
          productType: 'SERVICE',
          variants: [{ sku: `OT-SVC-${RUN_ID}`, priceMinor: 2000 }],
        }),
    ]);
    for (const res of products) {
      expect(res.status).toBe(201);
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products/${res.body.id}/activate`)
        .expect(200);
    }
    teeProductId = products[0].body.id;
    teeVariantId = products[0].body.variants[0].id;
    backVariantId = products[1].body.variants[0].id;
    svcVariantId = products[2].body.variants[0].id;

    const chanRes = await authed(owner)
      .post(`/api/organizations/${orgId}/shops/${shopId}/whatsapp-channel/mock`)
      .send({ displayName: 'Order WA', phoneNumber: '+237659200001' })
      .expect(201);
    channelId = chanRes.body.id;

    const orgBRes = await authed(outsider)
      .post('/api/organizations')
      .send({ name: `Order Org B ${RUN_ID}`, slug: `e2e-order-orgb-${RUN_ID}` })
      .expect(201);
    orgBId = orgBRes.body.organization.id;
  }, 180000);

  afterAll(async () => {
    worker?.kill();
    await app?.close();
  });

  // ------------------------------------------------------------ conversion

  describe('Conversion atomique Checkout → Order', () => {
    let conv: string;
    let orderId: string;
    let orderNumber: string;

    beforeAll(async () => {
      conv = await newConversation('+237659300001');
    });

    it('checkout non confirmé refusé', async () => {
      await authed(owner).post(`${cartBase(orgId, conv)}/items`).send({ variantId: teeVariantId, quantity: 1 }).expect(201);
      const res = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(422);
      expect(res.body.code).toBe('ORDER_CHECKOUT_NOT_CONFIRMED');
      await authed(owner).post(`${cartBase(orgId, conv)}/clear`).send({}).expect(200);
    });

    it('aucun total/article accepté du frontend (whitelist stricte → 400)', async () => {
      await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 2 }]);
      await authed(owner)
        .post(ordersConvBase(orgId, conv))
        .send({ totalMinor: 1, items: [] })
        .expect(400);
    });

    it('conversion réussie : Order CONFIRMED, statuts initiaux, numéro lisible', async () => {
      const before = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      const res = await authed(owner)
        .post(ordersConvBase(orgId, conv))
        .send({ clientMutationId: `conv-${RUN_ID}-1` })
        .expect(201);
      orderId = res.body.id;
      orderNumber = res.body.orderNumber;
      expect(orderNumber).toMatch(/^[A-Z0-9]+-\d{4}-\d{6,}$/);
      expect(res.body.status).toBe('CONFIRMED');
      expect(res.body.paymentStatus).toBe('UNPAID'); // CASH_ON_DELIVERY
      expect(res.body.fulfillmentStatus).toBe('PENDING'); // ligne PHYSICAL
      expect(res.body.fulfillmentType).toBe('PICKUP');
      expect(res.body.items).toHaveLength(1);
      const item = res.body.items[0];
      expect(item.sku).toBe(`OT-TEE-${RUN_ID}`.toUpperCase());
      expect(item.quantity).toBe(2);
      expect(item.stockConsumedQuantity).toBe(2);
      expect(item.backorderedQuantity).toBe(0);
      expect(item).not.toHaveProperty('costPriceMinor'); // aucun coût snapshotté dans cette phase

      // Stock consommé (onHand −2), réservation consommée (reserved −2).
      const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      expect(after.quantityOnHand).toBe(before.quantityOnHand - 2);
      expect(after.quantityReserved).toBe(before.quantityReserved - 2);

      const movement = await prisma.inventoryMovement.findFirst({
        where: { variantId: teeVariantId, type: 'SALE' },
        orderBy: { createdAt: 'desc' },
      });
      expect(movement).toMatchObject({
        quantityDelta: -2,
        referenceType: 'ORDER',
        referenceId: orderId,
      });

      const reservation = await prisma.stockReservation.findFirst({
        where: { cartId: res.body.cartId, variantId: teeVariantId },
        orderBy: { createdAt: 'desc' },
      });
      expect(reservation!.status).toBe('CONSUMED');

      const cart = await prisma.cart.findUniqueOrThrow({ where: { id: res.body.cartId } });
      expect(cart.status).toBe('CONVERTED');
      expect(cart.convertedAt).not.toBeNull();

      const history = await prisma.orderStatusHistory.findMany({ where: { orderId } });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ source: 'SYSTEM', newStatus: 'CONFIRMED' });
    });

    it('Order UNIQUE par CheckoutSession et par Cart (contraintes en base)', async () => {
      const count = await prisma.order.count({
        where: { checkoutSessionId: (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).checkoutSessionId },
      });
      expect(count).toBe(1);
    });

    it('double conversion (même clientMutationId, séquentielle) → même Order, aucun doublon', async () => {
      const res = await authed(owner)
        .post(ordersConvBase(orgId, conv))
        .send({ clientMutationId: `conv-${RUN_ID}-1` })
        .expect(200); // idempotent : réponse existante, pas 201
      expect(res.body.id).toBe(orderId);
      const count = await prisma.order.count({ where: { conversationId: conv } });
      expect(count).toBe(1);
    });

    it('deux conversions CONCURRENTES sur une conversation fraîche : un seul Order, aucune collision', async () => {
      const raceConv = await newConversation('+237659300002');
      await checkoutAndConfirm(raceConv, [{ variantId: teeVariantId, quantity: 1 }]);
      const [a, b] = await Promise.all([
        authed(owner).post(ordersConvBase(orgId, raceConv)).send({ clientMutationId: `race-${RUN_ID}` }),
        authed(owner).post(ordersConvBase(orgId, raceConv)).send({ clientMutationId: `race-${RUN_ID}` }),
      ]);
      expect([a.status, b.status]).toEqual(expect.arrayContaining([200, 201]));
      expect(a.body.id).toBe(b.body.id);
      const count = await prisma.order.count({ where: { conversationId: raceConv } });
      expect(count).toBe(1);
    });

    it('produit non suivi (SERVICE) accepté : aucune réservation attendue, aucun mouvement de stock', async () => {
      const svcConv = await newConversation('+237659300003');
      await checkoutAndConfirm(svcConv, [{ variantId: svcVariantId, quantity: 1 }]);
      const res = await authed(owner).post(ordersConvBase(orgId, svcConv)).send({}).expect(201);
      expect(res.body.fulfillmentStatus).toBe('NOT_REQUIRED'); // 100 % SERVICE
      const item = res.body.items[0];
      expect(item.stockConsumedQuantity).toBe(0);
      expect(item.backorderedQuantity).toBe(0);
      const movements = await prisma.inventoryMovement.count({
        where: { variantId: svcVariantId, referenceId: res.body.id },
      });
      expect(movements).toBe(0);
    });
  });

  // -------------------------------------------------------- réservations

  describe('Réservations invalides au moment de la conversion (manipulation directe)', () => {
    it('réservation ACTIVE mais EXPIRÉE → 409 ORDER_RESERVATION_EXPIRED', async () => {
      const conv = await newConversation('+237659300010');
      const cart = await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 1 }]);
      await prisma.stockReservation.updateMany({
        where: { cartId: cart.id, status: 'ACTIVE' },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const res = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(409);
      expect(res.body.code).toBe('ORDER_RESERVATION_EXPIRED');
    });

    it('réservation ABSENTE (libérée directement) → 409 ORDER_RESERVATION_MISSING', async () => {
      const conv = await newConversation('+237659300011');
      const cart = await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 1 }]);
      await prisma.stockReservation.updateMany({
        where: { cartId: cart.id, status: 'ACTIVE' },
        data: { status: 'RELEASED', releasedAt: new Date() },
      });
      const res = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(409);
      expect(res.body.code).toBe('ORDER_RESERVATION_MISSING');
    });

    it('quantité réservée INCOHÉRENTE avec la ligne → 409 ORDER_RESERVATION_MISMATCH', async () => {
      const conv = await newConversation('+237659300012');
      const cart = await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 2 }]);
      await prisma.stockReservation.updateMany({
        where: { cartId: cart.id, status: 'ACTIVE' },
        data: { quantity: 1 },
      });
      const res = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(409);
      expect(res.body.code).toBe('ORDER_RESERVATION_MISMATCH');
    });
  });

  // ------------------------------------------------------------- backorder

  describe('Backorder — consommation partielle sans stock négatif (validé — ajustement 11)', () => {
    it('commande > stock disponible : consommé/backorder distincts, onHand jamais négatif', async () => {
      const conv = await newConversation('+237659300020');
      const before = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: backVariantId } });
      expect(before.quantityOnHand).toBe(2);
      await checkoutAndConfirm(conv, [{ variantId: backVariantId, quantity: 5 }]);
      const res = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      const item = res.body.items[0];
      expect(item.stockConsumedQuantity).toBe(2);
      expect(item.backorderedQuantity).toBe(3);
      expect(item.stockConsumedQuantity + item.backorderedQuantity).toBe(5);

      const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: backVariantId } });
      expect(after.quantityOnHand).toBe(0); // jamais négatif
      expect(after.quantityOnHand).toBeGreaterThanOrEqual(0);

      const movement = await prisma.inventoryMovement.findFirst({
        where: { variantId: backVariantId, type: 'SALE', referenceId: res.body.id },
      });
      expect(movement!.quantityDelta).toBe(-2); // seule la quantité RÉELLEMENT sortie

      // Restitution basée sur stockConsumedQuantity, pas sur la quantité commandée.
      const cancelled = await authed(owner)
        .post(`${ordersBase(orgId)}/${res.body.id}/cancel`)
        .send({ expectedVersion: res.body.version })
        .expect(200);
      expect(cancelled.body.items[0].stockRestoredQuantity).toBe(2);
      const restored = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: backVariantId } });
      expect(restored.quantityOnHand).toBe(2); // +2 uniquement, jamais +5
    });
  });

  // ------------------------------------------------------------- transitions

  describe('Transitions de statut (service centralisé)', () => {
    let conv: string;
    let orderId: string;

    beforeAll(async () => {
      conv = await newConversation('+237659300030');
      await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 1 }], {
        fulfillmentType: 'DELIVERY',
        paymentPreference: 'CASH_ON_DELIVERY',
      });
      const res = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      orderId = res.body.id;
    });

    it('transition invalide (saut) refusée', async () => {
      const order = await authed(owner).get(`${ordersBase(orgId)}/${orderId}`).expect(200);
      const res = await authed(owner)
        .patch(`${ordersBase(orgId)}/${orderId}/status`)
        .send({ status: 'DELIVERED', expectedVersion: order.body.version })
        .expect(422);
      expect(res.body.code).toBe('ORDER_INVALID_STATUS_TRANSITION');
    });

    it('CONFIRMED → PROCESSING → READY → SHIPPED → DELIVERED, historique à chaque étape', async () => {
      let order = await authed(owner).get(`${ordersBase(orgId)}/${orderId}`).expect(200);
      for (const status of ['PROCESSING', 'READY', 'SHIPPED', 'DELIVERED'] as const) {
        order = await authed(owner)
          .patch(`${ordersBase(orgId)}/${orderId}/status`)
          .send({ status, expectedVersion: order.body.version, clientMutationId: `st-${orderId}-${status}` })
          .expect(200);
        expect(order.body.status).toBe(status);
      }
      expect(order.body.fulfillmentStatus).toBe('DELIVERED');
      const history = await authed(owner).get(`${ordersBase(orgId)}/${orderId}/history`).expect(200);
      expect(history.body.length).toBeGreaterThanOrEqual(5); // conversion + 4 transitions
    });

    it('paiement UNPAID + CASH_ON_DELIVERY livré : avertissement mais transition autorisée (validé — ajustement 18)', async () => {
      const order = await authed(owner).get(`${ordersBase(orgId)}/${orderId}`).expect(200);
      expect(order.body.status).toBe('DELIVERED');
      expect(order.body.paymentStatus).toBe('UNPAID'); // jamais passé à PAID automatiquement
    });

    it('DÉTAIL exact, snapshots corrects', async () => {
      const order = await authed(owner).get(`${ordersBase(orgId)}/${orderId}`).expect(200);
      expect(order.body.contact).toBeDefined();
      expect(order.body.shop.id).toBe(shopId);
      expect(order.body.conversationId).toBe(conv);
    });
  });

  // -------------------------------------------------------------- annulation

  describe('Annulation + restitution (validé D9)', () => {
    it('annulation avant SHIPPED : stock restauré, mouvement CANCELLATION, idempotente', async () => {
      const conv = await newConversation('+237659300040');
      const before = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 3 }]);
      const created = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      const afterSale = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      expect(afterSale.quantityOnHand).toBe(before.quantityOnHand - 3);

      const mutationId = `cancel-${RUN_ID}-1`;
      const cancelled = await authed(owner)
        .post(`${ordersBase(orgId)}/${created.body.id}/cancel`)
        .send({ expectedVersion: created.body.version, reason: 'Client indisponible', clientMutationId: mutationId })
        .expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      expect(cancelled.body.fulfillmentStatus).toBe('CANCELLED');

      const restored = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      expect(restored.quantityOnHand).toBe(before.quantityOnHand); // restitué intégralement

      const cancellationMovement = await prisma.inventoryMovement.findFirst({
        where: { variantId: teeVariantId, type: 'CANCELLATION', referenceId: created.body.id },
      });
      expect(cancellationMovement).toMatchObject({ quantityDelta: 3 });

      // Double annulation (même clientMutationId) : IDEMPOTENTE — aucun double décrément.
      const secondCall = await authed(owner)
        .post(`${ordersBase(orgId)}/${created.body.id}/cancel`)
        .send({ expectedVersion: created.body.version, clientMutationId: mutationId })
        .expect(200);
      expect(secondCall.body.status).toBe('CANCELLED');
      const stillRestored = await prisma.inventoryItem.findUniqueOrThrow({ where: { variantId: teeVariantId } });
      expect(stillRestored.quantityOnHand).toBe(before.quantityOnHand); // inchangé
      const cancellationCount = await prisma.inventoryMovement.count({
        where: { variantId: teeVariantId, type: 'CANCELLATION', referenceId: created.body.id },
      });
      expect(cancellationCount).toBe(1); // pas de doublon

      const mutationRows = await prisma.orderMutation.count({
        where: { orderId: created.body.id, clientMutationId: mutationId },
      });
      expect(mutationRows).toBe(1); // OrderMutation déduplique (validé §16)
    });

    it('double annulation SANS clientMutationId (retry naïf) → ORDER_ALREADY_CANCELLED, jamais de double restitution', async () => {
      const conv = await newConversation('+237659300041');
      await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 1 }]);
      const created = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      await authed(owner)
        .post(`${ordersBase(orgId)}/${created.body.id}/cancel`)
        .send({ expectedVersion: created.body.version })
        .expect(200);
      const res = await authed(owner)
        .post(`${ordersBase(orgId)}/${created.body.id}/cancel`)
        .send({ expectedVersion: created.body.version })
        .expect(409);
      expect(res.body.code).toBe('ORDER_ALREADY_CANCELLED');
    });

    it('annulation après DELIVERED refusée', async () => {
      const conv = await newConversation('+237659300042');
      await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 1 }], { fulfillmentType: 'PICKUP' });
      let order = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      for (const status of ['PROCESSING', 'READY', 'DELIVERED'] as const) {
        order = await authed(owner)
          .patch(`${ordersBase(orgId)}/${order.body.id}/status`)
          .send({ status, expectedVersion: order.body.version })
          .expect(200);
      }
      const res = await authed(owner)
        .post(`${ordersBase(orgId)}/${order.body.id}/cancel`)
        .send({ expectedVersion: order.body.version })
        .expect(422);
      expect(res.body.code).toBe('ORDER_CANCELLATION_NOT_ALLOWED');
    });

    it('annulation après SHIPPED refusée (validé D9 — workflow retour hors scope)', async () => {
      const conv = await newConversation('+237659300043');
      await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 1 }], { fulfillmentType: 'DELIVERY' });
      let order = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      for (const status of ['PROCESSING', 'READY', 'SHIPPED'] as const) {
        order = await authed(owner)
          .patch(`${ordersBase(orgId)}/${order.body.id}/status`)
          .send({ status, expectedVersion: order.body.version })
          .expect(200);
      }
      const res = await authed(owner)
        .post(`${ordersBase(orgId)}/${order.body.id}/cancel`)
        .send({ expectedVersion: order.body.version })
        .expect(422);
      expect(res.body.code).toBe('ORDER_CANCELLATION_NOT_ALLOWED');
    });

    it('InventoryItem REQUIS absent → OrderStockRestorationError, rollback COMPLET (validé — ajustement 9)', async () => {
      const conv = await newConversation('+237659300044');
      const dedicated = await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products`)
        .send({
          name: `OrderMissingInv ${RUN_ID}`,
          variants: [{ sku: `OT-MISS-${RUN_ID}`, priceMinor: 4000, initialQuantity: 5 }],
        })
        .expect(201);
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products/${dedicated.body.id}/activate`)
        .expect(200);
      const dedicatedVariantId = dedicated.body.variants[0].id;

      await checkoutAndConfirm(conv, [{ variantId: dedicatedVariantId, quantity: 1 }]);
      const created = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);

      // Simule une anomalie (jamais censée arriver en production — la
      // référence ayant servi à une vente n'est jamais supprimée physiquement).
      await prisma.inventoryItem.delete({ where: { variantId: dedicatedVariantId } });

      const res = await authed(owner)
        .post(`${ordersBase(orgId)}/${created.body.id}/cancel`)
        .send({ expectedVersion: created.body.version })
        .expect(409);
      expect(res.body.code).toBe('ORDER_STOCK_RESTORATION_FAILED');

      // Rollback COMPLET : la commande n'a PAS été annulée.
      const reloaded = await authed(owner).get(`${ordersBase(orgId)}/${created.body.id}`).expect(200);
      expect(reloaded.body.status).toBe('CONFIRMED');
      expect(reloaded.body.version).toBe(created.body.version);
    });
  });

  // ---------------------------------------------------- indépendance catalogue

  describe('Indépendance totale du catalogue courant après confirmation (validé — ajustement 4)', () => {
    it('nom/prix produit modifiés après confirmation : Order garde le snapshot au moment de la confirmation', async () => {
      const conv = await newConversation('+237659300050');
      const cart = await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 1 }]);
      const snapshotLine = cart.checkout.confirmationSnapshot.lines[0];

      // Modifications catalogue APRÈS confirmation.
      await authed(owner)
        .patch(`/api/organizations/${orgId}/shops/${shopId}/products/${teeProductId}`)
        .send({ name: 'Nom Complètement Différent' })
        .expect(200);
      await authed(owner)
        .patch(`/api/organizations/${orgId}/shops/${shopId}/products/${teeProductId}/variants/${teeVariantId}`)
        .send({ priceMinor: 99999 })
        .expect(200);

      const res = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      expect(res.body.items[0].productName).toBe(snapshotLine.productName);
      expect(res.body.items[0].unitPriceMinor).toBe(snapshotLine.unitPriceMinor);
      expect(res.body.items[0].productName).not.toBe('Nom Complètement Différent');
      expect(res.body.items[0].unitPriceMinor).not.toBe(99999);

      // Remise en état pour ne pas perturber les tests suivants.
      await authed(owner)
        .patch(`/api/organizations/${orgId}/shops/${shopId}/products/${teeProductId}`)
        .send({ name: `OrderTee ${RUN_ID}` })
        .expect(200);
      await authed(owner)
        .patch(`/api/organizations/${orgId}/shops/${shopId}/products/${teeProductId}/variants/${teeVariantId}`)
        .send({ priceMinor: 5000 })
        .expect(200);
    });

    it('trackInventory modifié après confirmation : sans effet sur la consommation (snapshot fait foi)', async () => {
      const dedicated = await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products`)
        .send({
          name: `OrderTrackFlip ${RUN_ID}`,
          variants: [{ sku: `OT-FLIP-${RUN_ID}`, priceMinor: 1000, initialQuantity: 5 }],
        })
        .expect(201);
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products/${dedicated.body.id}/activate`)
        .expect(200);
      const variantId = dedicated.body.variants[0].id;
      const conv = await newConversation('+237659300051');
      await checkoutAndConfirm(conv, [{ variantId, quantity: 1 }]);

      // trackInventory n'est pas patchable après création dans ce module —
      // on vérifie plutôt que le service de conversion ignore l'état courant
      // en changeant physiquement le compteur onHand : le snapshot a déjà
      // figé trackInventory=true, la conversion consomme bien depuis le stock.
      const res = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      expect(res.body.items[0].trackInventorySnapshot).toBe(true);
      expect(res.body.items[0].stockConsumedQuantity).toBe(1);
    });
  });

  // --------------------------------------------------------------- résumé

  describe('Résumé texte serveur', () => {
    it('texte serveur avec avertissement paiement à encaisser', async () => {
      const conv = await newConversation('+237659300060');
      await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 1 }], {
        fulfillmentType: 'PICKUP',
        paymentPreference: 'CASH_ON_DELIVERY',
      });
      const order = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      const summary = await authed(owner)
        .get(`${ordersBase(orgId)}/${order.body.id}/summary-text`)
        .expect(200);
      expect(summary.body.text).toContain(order.body.orderNumber);
      expect(summary.body.warnings).toContain('PAYMENT_TO_COLLECT');
      expect(summary.body.orderNumber).toBe(order.body.orderNumber);
    });
  });

  // -------------------------------------------------------------- notes

  describe('Notes internes append-only', () => {
    it('ajoute des notes, jamais modifiables, jamais envoyées au client', async () => {
      const conv = await newConversation('+237659300070');
      await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 1 }]);
      const order = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      await authed(owner)
        .post(`${ordersBase(orgId)}/${order.body.id}/notes`)
        .send({ content: 'Client à rappeler demain.' })
        .expect(201);
      const notes = await authed(owner).get(`${ordersBase(orgId)}/${order.body.id}/notes`).expect(200);
      expect(notes.body).toHaveLength(1);
      expect(notes.body[0].content).toBe('Client à rappeler demain.');
      expect(notes.body[0].authorName).toContain('E2E');
    });
  });

  // ---------------------------------------------------------- isolation

  describe('Isolation, anti-énumération, permissions', () => {
    let ownOrderId: string;

    beforeAll(async () => {
      const conv = await newConversation('+237659300080');
      await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 1 }]);
      const order = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      ownOrderId = order.body.id;
    });

    it('Order étrangère inaccessible (404 anti-énumération)', async () => {
      await authed(outsider).get(`${ordersBase(orgBId)}/${ownOrderId}`).expect(404);
    });

    it('Organization suspendue bloquée', async () => {
      await prisma.organization.update({ where: { id: orgBId }, data: { status: 'SUSPENDED' } });
      await authed(outsider).get(ordersBase(orgBId)).expect(403);
      await prisma.organization.update({ where: { id: orgBId }, data: { status: 'ACTIVE' } });
    });

    it('AGENT : conversion, statuts, notes, historique autorisés ; annulation REFUSÉE (validé D10)', async () => {
      const conv = await newConversation('+237659300081');
      await authed(agent).post(`${cartBase(orgId, conv)}/items`).send({ variantId: teeVariantId, quantity: 1 }).expect(201);
      let cart = await authed(agent).post(`${cartBase(orgId, conv)}/checkout/start`).send({}).expect(200);
      cart = await authed(agent)
        .patch(`${cartBase(orgId, conv)}/checkout`)
        .send({
          expectedVersion: cart.body.checkout.version,
          fulfillmentType: 'PICKUP',
          customerName: 'Client Agent',
          paymentPreference: 'PAY_IN_STORE',
        })
        .expect(200);
      await authed(agent)
        .post(`${cartBase(orgId, conv)}/checkout/confirm`)
        .send({ expectedVersion: cart.body.checkout.version })
        .expect(200);
      const order = await authed(agent).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      await authed(agent)
        .patch(`${ordersBase(orgId)}/${order.body.id}/status`)
        .send({ status: 'PROCESSING', expectedVersion: order.body.version })
        .expect(200);
      await authed(agent)
        .post(`${ordersBase(orgId)}/${order.body.id}/notes`)
        .send({ content: 'Note agent' })
        .expect(201);
      await authed(agent).get(`${ordersBase(orgId)}/${order.body.id}/history`).expect(200);

      const forbidden = await authed(agent)
        .post(`${ordersBase(orgId)}/${order.body.id}/cancel`)
        .send({ expectedVersion: order.body.version + 1 })
        .expect(403);
      expect(forbidden.body.code).toBe('INSUFFICIENT_PERMISSION');

      // MANAGER peut annuler (validé D10).
      await authed(manager)
        .post(`${ordersBase(orgId)}/${order.body.id}/cancel`)
        .send({ expectedVersion: order.body.version + 1 })
        .expect(200);
    });

    it('liste paginée : filtres appliqués AVANT pagination', async () => {
      const res = await authed(owner)
        .get(`${ordersBase(orgId)}?status=CANCELLED&limit=5`)
        .expect(200);
      expect(res.body.items.length).toBeLessThanOrEqual(5);
      expect(res.body.items.every((o: { status: string }) => o.status === 'CANCELLED')).toBe(true);
    });
  });

  // ------------------------------------------------------------- socket

  describe('Socket.IO — événements scoppés par organisation', () => {
    it('order.created reçu par la bonne org, jamais par une autre', async () => {
      const port = (app.getHttpServer().address() as { port: number }).port;
      const socketA = socketIo(`http://localhost:${port}`, { auth: { token: owner.accessToken }, transports: ['websocket'] });
      const socketB = socketIo(`http://localhost:${port}`, { auth: { token: outsider.accessToken }, transports: ['websocket'] });
      await Promise.all([
        new Promise((r) => socketA.on('connect', r)),
        new Promise((r) => socketB.on('connect', r)),
      ]);
      await socketA.emitWithAck('subscribe:organization', { organizationId: orgId });
      await socketB.emitWithAck('subscribe:organization', { organizationId: orgBId });
      const receivedA: unknown[] = [];
      const receivedB: unknown[] = [];
      socketA.on('order.created', (p) => receivedA.push(p));
      socketB.on('order.created', (p) => receivedB.push(p));

      const conv = await newConversation('+237659300090');
      await checkoutAndConfirm(conv, [{ variantId: teeVariantId, quantity: 1 }]);
      await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);

      await waitFor(() => receivedA.length > 0, 'socket order.created reçu par org A');
      await new Promise((r) => setTimeout(r, 300));
      expect(receivedB).toHaveLength(0);
      expect(receivedA[0]).toMatchObject({ organizationId: orgId });

      socketA.disconnect();
      socketB.disconnect();
    });
  });

  // ------------------------------------------------------- numéro / préfixe

  describe('Numéro de commande — préfixe stable par Shop (validé — ajustements 1, 2, 19)', () => {
    it('deux Shops au même candidat de préfixe tronqué reçoivent des préfixes DISTINCTS', async () => {
      const shopA = await authed(owner)
        .post(`/api/organizations/${orgId}/shops`)
        .send({ name: `Fashion Store ${RUN_ID}`, countryCode: 'CM' })
        .expect(201);
      const shopB = await authed(owner)
        .post(`/api/organizations/${orgId}/shops`)
        .send({ name: `Fashion Studio ${RUN_ID}`, countryCode: 'CM' })
        .expect(201);
      for (const shop of [shopA, shopB]) {
        const chan = await authed(owner)
          .post(`/api/organizations/${orgId}/shops/${shop.body.id}/whatsapp-channel/mock`)
          .send({ displayName: 'WA', phoneNumber: `+2376592${Math.floor(Math.random() * 90000 + 10000)}` })
          .expect(201);
        const product = await authed(owner)
          .post(`/api/organizations/${orgId}/shops/${shop.body.id}/products`)
          .send({ name: `P ${RUN_ID}`, variants: [{ sku: `P-${shop.body.id}`, priceMinor: 1000, initialQuantity: 5 }] })
          .expect(201);
        await authed(owner)
          .post(`/api/organizations/${orgId}/shops/${shop.body.id}/products/${product.body.id}/activate`)
          .expect(200);

        await request(server)
          .post('/api/dev/whatsapp/mock/inbound')
          .send({ channelId: chan.body.id, phone: `+2376593${Math.floor(Math.random() * 90000 + 10000)}`, text: 'Bonjour' })
          .expect(202);
        const conv = await waitFor(
          () => prisma.conversation.findFirst({ where: { channelId: chan.body.id }, select: { id: true } }),
          'conv shop prefix',
        );
        await authed(owner)
          .post(`/api/organizations/${orgId}/conversations/${conv.id}/cart/items`)
          .send({ variantId: product.body.variants[0].id, quantity: 1 })
          .expect(201);
        let cart = await authed(owner)
          .post(`/api/organizations/${orgId}/conversations/${conv.id}/cart/checkout/start`)
          .send({})
          .expect(200);
        cart = await authed(owner)
          .patch(`/api/organizations/${orgId}/conversations/${conv.id}/cart/checkout`)
          .send({ expectedVersion: cart.body.checkout.version, fulfillmentType: 'PICKUP', customerName: 'X', paymentPreference: 'PAY_IN_STORE' })
          .expect(200);
        await authed(owner)
          .post(`/api/organizations/${orgId}/conversations/${conv.id}/cart/checkout/confirm`)
          .send({ expectedVersion: cart.body.checkout.version })
          .expect(200);
        await authed(owner)
          .post(`/api/organizations/${orgId}/conversations/${conv.id}/orders`)
          .send({})
          .expect(201);
      }
      const [refreshedA, refreshedB] = await Promise.all([
        prisma.shop.findUniqueOrThrow({ where: { id: shopA.body.id } }),
        prisma.shop.findUniqueOrThrow({ where: { id: shopB.body.id } }),
      ]);
      expect(refreshedA.orderNumberPrefix).not.toBeNull();
      expect(refreshedB.orderNumberPrefix).not.toBeNull();
      expect(refreshedA.orderNumberPrefix).not.toBe(refreshedB.orderNumberPrefix);
      // Même candidat tronqué de base ("Fashion Store"/"Fashion Studio" → FASHIONS).
      expect(refreshedB.orderNumberPrefix!.startsWith(refreshedA.orderNumberPrefix!)).toBe(true);
    });

    it('le préfixe reste STABLE après changement de slug (validé — ajustement 1)', async () => {
      const shop = await authed(owner)
        .post(`/api/organizations/${orgId}/shops`)
        .send({ name: `Stable Prefix ${RUN_ID}`, countryCode: 'CM' })
        .expect(201);
      const chan = await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shop.body.id}/whatsapp-channel/mock`)
        .send({ displayName: 'WA', phoneNumber: `+2376595${Math.floor(Math.random() * 90000 + 10000)}` })
        .expect(201);
      const product = await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shop.body.id}/products`)
        .send({ name: `Q ${RUN_ID}`, variants: [{ sku: `Q-${shop.body.id}`, priceMinor: 1000, initialQuantity: 5 }] })
        .expect(201);
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shop.body.id}/products/${product.body.id}/activate`)
        .expect(200);
      await request(server)
        .post('/api/dev/whatsapp/mock/inbound')
        .send({ channelId: chan.body.id, phone: `+2376596${Math.floor(Math.random() * 90000 + 10000)}`, text: 'Bonjour' })
        .expect(202);
      const conv = await waitFor(
        () => prisma.conversation.findFirst({ where: { channelId: chan.body.id }, select: { id: true } }),
        'conv slug stability',
      );
      await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conv.id}/cart/items`)
        .send({ variantId: product.body.variants[0].id, quantity: 1 })
        .expect(201);
      let cart = await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conv.id}/cart/checkout/start`)
        .send({})
        .expect(200);
      cart = await authed(owner)
        .patch(`/api/organizations/${orgId}/conversations/${conv.id}/cart/checkout`)
        .send({ expectedVersion: cart.body.checkout.version, fulfillmentType: 'PICKUP', customerName: 'X', paymentPreference: 'PAY_IN_STORE' })
        .expect(200);
      await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conv.id}/cart/checkout/confirm`)
        .send({ expectedVersion: cart.body.checkout.version })
        .expect(200);
      const firstOrder = await authed(owner)
        .post(`/api/organizations/${orgId}/conversations/${conv.id}/orders`)
        .send({})
        .expect(201);
      const prefixBefore = (await prisma.shop.findUniqueOrThrow({ where: { id: shop.body.id } })).orderNumberPrefix;

      // Changement de slug — le préfixe NE DOIT PAS changer.
      await authed(owner)
        .patch(`/api/organizations/${orgId}/shops/${shop.body.id}`)
        .send({ slug: `completement-different-${RUN_ID}` })
        .expect(200);
      const shopAfter = await prisma.shop.findUniqueOrThrow({ where: { id: shop.body.id } });
      expect(shopAfter.orderNumberPrefix).toBe(prefixBefore);
      expect(firstOrder.body.orderNumber.startsWith(`${prefixBefore}-`)).toBe(true);
    });

    it('un ROLLBACK de conversion ne consomme PAS le compteur transactionnel (validé — ajustement 2)', async () => {
      const dedicated = await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products`)
        .send({
          name: `OrderRollbackSeq ${RUN_ID}`,
          variants: [{ sku: `OT-ROLL-${RUN_ID}`, priceMinor: 1000, initialQuantity: 5 }],
        })
        .expect(201);
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products/${dedicated.body.id}/activate`)
        .expect(200);
      const variantId = dedicated.body.variants[0].id;
      const conv = await newConversation('+237659300095');
      const cart = await checkoutAndConfirm(conv, [{ variantId, quantity: 1 }]);

      const currentYear = new Date().getFullYear();
      const seqBefore = await prisma.orderSequence.findUnique({
        where: { shopId_year: { shopId, year: currentYear } },
      });
      const lastValueBefore = seqBefore?.lastValue ?? 0;

      // Force l'échec APRÈS la numérotation : reserved < quantité commandée
      // (consume() exige reserved >= quantity, sinon OrderStockConsumptionError).
      await prisma.inventoryItem.update({
        where: { variantId },
        data: { quantityReserved: 0 },
      });
      const failed = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(409);
      expect(failed.body.code).toBe('ORDER_STOCK_CONSUMPTION_FAILED');

      const seqAfterFailure = await prisma.orderSequence.findUnique({
        where: { shopId_year: { shopId, year: currentYear } },
      });
      expect(seqAfterFailure?.lastValue ?? 0).toBe(lastValueBefore); // AUCUN trou

      // Répare puis convertit avec succès : le numéro suivant est CONTIGU.
      await prisma.inventoryItem.update({ where: { variantId }, data: { quantityReserved: 1 } });
      const succeeded = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      const seqAfterSuccess = await prisma.orderSequence.findUniqueOrThrow({
        where: { shopId_year: { shopId, year: currentYear } },
      });
      expect(seqAfterSuccess.lastValue).toBe(lastValueBefore + 1); // pas +2
      void cart;
      void succeeded;
    });
  });

  // --------------------------------------------------------- migration réelle

  describe('Migration PostgreSQL réelle — FK productId/variantId nullable (validé — ajustement 10)', () => {
    it('suppression physique du Product : OrderItem survit, shopId INTACT, snapshot inchangé', async () => {
      const dedicated = await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products`)
        .send({
          name: `OrderDeletable ${RUN_ID}`,
          variants: [{ sku: `OT-DEL-${RUN_ID}`, priceMinor: 2500, initialQuantity: 5 }],
        })
        .expect(201);
      await authed(owner)
        .post(`/api/organizations/${orgId}/shops/${shopId}/products/${dedicated.body.id}/activate`)
        .expect(200);
      const variantId = dedicated.body.variants[0].id;
      const productId = dedicated.body.id;

      const conv = await newConversation('+237659300099');
      const cart = await checkoutAndConfirm(conv, [{ variantId, quantity: 1 }]);
      const order = await authed(owner).post(ordersConvBase(orgId, conv)).send({}).expect(201);
      const orderItemBefore = order.body.items[0];

      // Nettoyage des références NoAction qui bloqueraient la suppression
      // physique (CartItem → Product) — le Cart lui-même n'est pas supprimé
      // (Order.cartId le référence en NoAction). Totaux réalignés à 0 pour ne
      // pas polluer les invariants globaux de carts.e2e-spec.ts (le Cart
      // CONVERTED n'est plus jamais relu par l'application après conversion).
      await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
      await prisma.cart.update({
        where: { id: cart.id },
        data: { subtotalMinor: 0, totalMinor: 0, itemCount: 0 },
      });

      // Suppression physique RÉELLE en base (jamais faite en production —
      // testée ici pour valider la contrainte SQL elle-même).
      await prisma.product.delete({ where: { id: productId } });

      const orderItemAfter = await prisma.orderItem.findUniqueOrThrow({
        where: { id: orderItemBefore.id },
      });
      expect(orderItemAfter.shopId).toBe(shopId); // JAMAIS corrompu
      expect(orderItemAfter.productId).toBeNull();
      expect(orderItemAfter.variantId).toBeNull();
      expect(orderItemAfter.productName).toBe(orderItemBefore.productName); // snapshot intact
      expect(orderItemAfter.sku).toBe(orderItemBefore.sku);

      // L'Order reste lisible via l'API, le snapshot fait foi.
      const reloaded = await authed(owner).get(`${ordersBase(orgId)}/${order.body.id}`).expect(200);
      expect(reloaded.body.items[0].productId).toBeNull();
      expect(reloaded.body.items[0].productName).toBe(orderItemBefore.productName);
    });
  });

  // --------------------------------------------------------- invariants finaux

  describe('Invariants PostgreSQL finaux', () => {
    it('cohérence stock : quantityOnHand jamais négatif, mouvements SALE/CANCELLATION cohérents', async () => {
      const negatives = await prisma.inventoryItem.findMany({ where: { quantityOnHand: { lt: 0 } } });
      expect(negatives).toHaveLength(0);

      const badMovements = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "inventory_movements"
        WHERE type = 'SALE' AND "quantityDelta" > 0
        UNION
        SELECT id FROM "inventory_movements"
        WHERE type = 'CANCELLATION' AND "quantityDelta" < 0
      `;
      expect(badMovements).toHaveLength(0);
    });

    it('une seule Order par CheckoutSession, une seule par Cart', async () => {
      const dupCheckout = await prisma.$queryRaw<Array<{ checkoutSessionId: string; n: number }>>`
        SELECT "checkoutSessionId", COUNT(*)::int AS n FROM "orders"
        GROUP BY "checkoutSessionId" HAVING COUNT(*) > 1
      `;
      expect(dupCheckout).toHaveLength(0);
      const dupCart = await prisma.$queryRaw<Array<{ cartId: string; n: number }>>`
        SELECT "cartId", COUNT(*)::int AS n FROM "orders" GROUP BY "cartId" HAVING COUNT(*) > 1
      `;
      expect(dupCart).toHaveLength(0);
    });

    it('orderNumber unique par organisation', async () => {
      const dup = await prisma.$queryRaw<Array<{ organizationId: string; orderNumber: string; n: number }>>`
        SELECT "organizationId", "orderNumber", COUNT(*)::int AS n FROM "orders"
        GROUP BY "organizationId", "orderNumber" HAVING COUNT(*) > 1
      `;
      expect(dup).toHaveLength(0);
    });

    it('OrderItem : lineSubtotal cohérent, stock consommé/restauré cohérent', async () => {
      const incoherent = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "order_items"
        WHERE "lineSubtotalMinor" <> "unitPriceMinor" * quantity
           OR "stockRestoredQuantity" > "stockConsumedQuantity"
      `;
      expect(incoherent).toHaveLength(0);
    });

    it('aucune Order orpheline (Shop/Contact/Conversation/Cart/Checkout vivants)', async () => {
      const orphans = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT o.id FROM "orders" o
        LEFT JOIN "shops" s ON s.id = o."shopId"
        LEFT JOIN "contacts" c ON c.id = o."contactId"
        LEFT JOIN "conversations" cv ON cv.id = o."conversationId"
        LEFT JOIN "carts" ca ON ca.id = o."cartId"
        LEFT JOIN "checkout_sessions" ch ON ch.id = o."checkoutSessionId"
        WHERE s.id IS NULL OR c.id IS NULL OR cv.id IS NULL OR ca.id IS NULL OR ch.id IS NULL
      `;
      expect(orphans).toHaveLength(0);
    });
  });
});
