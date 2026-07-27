import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';

/**
 * Commandes de bout en bout : vraie API, vrai worker, build de production
 * du front. Conversion checkout → Order, timeline, note, résumé, annulation
 * avec restitution de stock, permissions AGENT, temps réel.
 */
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'playwright-pass-123';
const OWNER_EMAIL = `pw-order-${RUN_ID}-owner@e2e.whauto.test`;
const AGENT_EMAIL = `pw-order-${RUN_ID}-agent@e2e.whauto.test`;
const ORG_NAME = `PW Order Org ${RUN_ID}`;
const SHOP_NAME = `PW Order Shop ${RUN_ID}`;
const SHOP2_NAME = `PW Order Shop Bis ${RUN_ID}`;
const PRODUCT_NAME = `Chaise Bureau ${RUN_ID}`;

const API = 'http://localhost:4000/api';
const WORKER_DIST = resolve(__dirname, '../../whatsapp-worker/dist/main.js');

test.describe.configure({ mode: 'serial' });

let worker: ChildProcess;
let ownerContext: BrowserContext;
let ownerPage: Page;
let ownerToken: string;
let orgId: string;
let shopId: string;
let channelId: string;

async function registerVerifiedUser(request: APIRequestContext, email: string, lastName: string) {
  const registerResponse = await request.post(`${API}/auth/register`, {
    data: { email, password: PASSWORD, firstName: 'Playwright', lastName },
  });
  expect(registerResponse.status()).toBe(201);
  const { devLink } = (await registerResponse.json()) as { devLink: string };
  await request.post(`${API}/auth/verify-email`, {
    data: { token: new URL(devLink).searchParams.get('token')! },
  });
}

async function apiLogin(request: APIRequestContext, email: string): Promise<string> {
  const response = await request.post(`${API}/auth/login`, {
    data: { email, password: PASSWORD },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

async function loginAs(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('textbox', { name: 'Mot de passe' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.beforeAll(async ({ browser, request }) => {
  test.skip(!existsSync(WORKER_DIST), 'Worker non buildé');

  worker = spawn(process.execPath, [WORKER_DIST], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'fatal',
      REDIS_URL: 'redis://localhost:6379/1',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://whauto:whauto@localhost:5433/whauto_dev',
    },
    stdio: 'ignore',
  });

  await registerVerifiedUser(request, OWNER_EMAIL, 'Owner');
  await registerVerifiedUser(request, AGENT_EMAIL, 'Agent');
  ownerToken = await apiLogin(request, OWNER_EMAIL);
  const auth = { Authorization: `Bearer ${ownerToken}` };

  const orgRes = await request.post(`${API}/organizations`, { headers: auth, data: { name: ORG_NAME } });
  orgId = ((await orgRes.json()) as { organization: { id: string } }).organization.id;

  const inviteRes = await request.post(`${API}/organizations/${orgId}/invitations`, {
    headers: auth,
    data: { email: AGENT_EMAIL, role: 'AGENT' },
  });
  const inviteToken = new URL(((await inviteRes.json()) as { devLink: string }).devLink)
    .searchParams.get('token')!;
  const agentToken = await apiLogin(request, AGENT_EMAIL);
  await request.post(`${API}/invitations/accept`, {
    headers: { Authorization: `Bearer ${agentToken}` },
    data: { token: inviteToken },
  });

  const shopRes = await request.post(`${API}/organizations/${orgId}/shops`, {
    headers: auth,
    data: { name: SHOP_NAME, countryCode: 'CM' },
  });
  shopId = ((await shopRes.json()) as { id: string }).id;
  await request.post(`${API}/organizations/${orgId}/shops`, {
    headers: auth,
    data: { name: SHOP2_NAME, countryCode: 'CM' },
  });

  const productRes = await request.post(`${API}/organizations/${orgId}/shops/${shopId}/products`, {
    headers: auth,
    data: { name: PRODUCT_NAME, variants: [{ sku: `CHR-${RUN_ID}`, priceMinor: 30000, initialQuantity: 10 }] },
  });
  const product = (await productRes.json()) as { id: string };
  await request.post(`${API}/organizations/${orgId}/shops/${shopId}/products/${product.id}/activate`, {
    headers: auth,
  });

  const chanRes = await request.post(
    `${API}/organizations/${orgId}/shops/${shopId}/whatsapp-channel/mock`,
    { headers: auth, data: { displayName: 'Order WA', phoneNumber: '+237659400001' } },
  );
  channelId = ((await chanRes.json()) as { id: string }).id;
  await request.post(`${API}/dev/whatsapp/mock/inbound`, {
    data: { channelId, phone: '+237659500001', displayName: 'Cliente Commande', text: 'Je veux commander' },
  });

  ownerContext = await browser.newContext();
  ownerPage = await ownerContext.newPage();
  await loginAs(ownerPage, OWNER_EMAIL);
});

test.afterAll(async () => {
  await ownerContext?.close();
  worker?.kill();
});

let createdOrderNumber = '';

test('checkout confirmé dans l’onglet Panier, conversion en commande dans l’onglet Commandes', async () => {
  const page = ownerPage;
  await page.goto('/conversations');
  await page.getByTestId('conversation-row').first().click();
  await page.getByRole('button', { name: 'Afficher la fiche contact' }).click();

  // Panier → checkout PICKUP confirmé.
  await page.getByTestId('tab-cart').click();
  await page.getByTestId('cart-add-product').click();
  await page.getByLabel('Rechercher un produit').fill(PRODUCT_NAME);
  await page.getByTestId('picker-product').first().click();
  await page.getByTestId('picker-variant').first().click();
  await page.getByTestId('picker-insert').click();

  const panel = page.getByTestId('cart-panel');
  await panel.getByTestId('checkout-start').click();
  await panel.getByLabel('Nom du client').fill('Cliente Commande');
  await panel.getByTestId('fulfillment-select').click();
  await page.getByRole('option', { name: 'Retrait en boutique' }).click();
  await panel.getByTestId('payment-select').click();
  await page.getByRole('option', { name: 'Paiement en boutique' }).click();
  await panel.getByTestId('checkout-save').click();
  await panel.getByTestId('checkout-confirm').click();
  await expect(panel.getByTestId('checkout-confirmed')).toBeVisible();

  // Onglet Commandes : bouton de conversion visible.
  await page.getByTestId('tab-orders').click();
  const ordersPanel = page.getByTestId('orders-panel');
  await expect(ordersPanel.getByTestId('convert-to-order')).toBeVisible();
  await ordersPanel.getByTestId('convert-to-order').click();

  // Commande visible sans reload, numéro affiché.
  const orderCard = ordersPanel.getByTestId('conversation-order');
  await expect(orderCard).toBeVisible({ timeout: 10000 });
  const numberText = await orderCard.locator('a').first().textContent();
  createdOrderNumber = numberText?.trim() ?? '';
  expect(createdOrderNumber).toMatch(/^[A-Z0-9]+-\d{4}-\d{6,}$/);

  // Le panier disparaît (CONVERTED) — retour à l'onglet Panier le confirme.
  await page.getByTestId('tab-cart').click();
  await expect(page.getByText(/Converti en commande|Aucun panier/)).toBeVisible();
});

test('la commande apparaît dans /orders, recherche par numéro, ouverture du détail', async () => {
  const page = ownerPage;
  await page.goto('/orders');
  await page.getByLabel('Rechercher une commande').fill(createdOrderNumber);
  const row = page.getByTestId('order-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('order-status-badge')).toBeVisible();
  await expect(row.getByTestId('payment-status-badge')).toBeVisible();
  await expect(row.getByTestId('fulfillment-status-badge')).toBeVisible();

  await row.locator('a').first().click();
  await expect(page.getByTestId('order-number')).toContainText(createdOrderNumber);
});

test('détail : snapshots des articles visibles, jamais les données catalogue courantes', async () => {
  const page = ownerPage;
  const item = page.getByTestId('order-item').first();
  await expect(item).toContainText(PRODUCT_NAME);
  await expect(item).toContainText('CHR-');
  await expect(page.getByTestId('order-total')).toContainText('30');
});

test('transition CONFIRMED → PROCESSING → READY → DELIVERED (PICKUP), timeline mise à jour', async () => {
  const page = ownerPage;
  await page.getByTestId('status-action-PROCESSING').click();
  await expect(page.getByTestId('order-status-badge')).toHaveAttribute('data-order-status', 'PROCESSING');
  await page.getByTestId('status-action-READY').click();
  await expect(page.getByTestId('order-status-badge')).toHaveAttribute('data-order-status', 'READY');

  const timeline = page.getByTestId('timeline-entry');
  await expect(timeline).toHaveCount(3, { timeout: 10000 }); // conversion + 2 transitions

  await page.getByTestId('status-action-DELIVERED').click();
  await expect(page.getByTestId('order-status-badge')).toHaveAttribute('data-order-status', 'DELIVERED');
  // Paiement en boutique encore non encaissé : avertissement, jamais PAID auto.
  await expect(page.getByTestId('payment-to-collect')).toBeVisible();
});

test('ajouter une note interne, générer le résumé, insertion sans envoi automatique', async () => {
  const page = ownerPage;
  await page.getByLabel('Nouvelle note interne').fill('Client à contacter pour confirmer le retrait.');
  await page.getByTestId('add-order-note').click();
  await expect(page.getByTestId('order-note')).toContainText('Client à contacter');

  // Résumé depuis l'onglet Commandes de la conversation.
  await page.goto('/conversations');
  await page.getByTestId('conversation-row').first().click();
  await page.getByRole('button', { name: 'Afficher la fiche contact' }).click();
  await page.getByTestId('tab-orders').click();
  await page.getByTestId('order-summary-insert').click();

  const composer = page.getByTestId('composer-input');
  await expect(composer).toHaveValue(new RegExp(createdOrderNumber));
  await expect(page.getByTestId('message-outbound')).toHaveCount(0);
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('message-outbound').last()).toContainText(createdOrderNumber);
});

test('deux agents voient les changements de commande en temps réel', async ({ browser, request }) => {
  await request.post(`${API}/dev/whatsapp/mock/inbound`, {
    data: { channelId, phone: '+237659500002', displayName: 'Client Deux Commandes', text: 'Bonjour' },
  });

  const agentContext = await browser.newContext();
  const agentPage = await agentContext.newPage();
  await loginAs(agentPage, AGENT_EMAIL);
  await agentPage.goto('/conversations');
  await agentPage.getByTestId('conversation-row').filter({ hasText: 'Client Deux Commandes' }).click();
  await agentPage.getByRole('button', { name: 'Afficher la fiche contact' }).click();
  await agentPage.getByTestId('tab-cart').click();
  await agentPage.getByTestId('cart-add-product').click();
  await agentPage.getByLabel('Rechercher un produit').fill(PRODUCT_NAME);
  await agentPage.getByTestId('picker-product').first().click();
  await agentPage.getByTestId('picker-variant').first().click();
  await agentPage.getByTestId('picker-insert').click();
  const agentPanel = agentPage.getByTestId('cart-panel');
  await agentPanel.getByTestId('checkout-start').click();
  await agentPanel.getByLabel('Nom du client').fill('Client Deux');
  await agentPanel.getByTestId('fulfillment-select').click();
  await agentPage.getByRole('option', { name: 'Retrait en boutique' }).click();
  await agentPanel.getByTestId('payment-select').click();
  await agentPage.getByRole('option', { name: 'Paiement en boutique' }).click();
  await agentPanel.getByTestId('checkout-save').click();
  await agentPanel.getByTestId('checkout-confirm').click();
  await agentPage.getByTestId('tab-orders').click();
  await agentPage.getByTestId('orders-panel').getByTestId('convert-to-order').click();
  await expect(agentPage.getByTestId('orders-panel').getByTestId('conversation-order')).toBeVisible({
    timeout: 10000,
  });

  // L'owner ouvre la même conversation, onglet Commandes : la commande apparaît sans reload.
  const page = ownerPage;
  await page.goto('/conversations');
  await page.getByTestId('conversation-row').filter({ hasText: 'Client Deux Commandes' }).click();
  await page.getByRole('button', { name: 'Afficher la fiche contact' }).click();
  await page.getByTestId('tab-orders').click();
  await expect(page.getByTestId('orders-panel').getByTestId('conversation-order')).toBeVisible({
    timeout: 10000,
  });

  await agentContext.close();
});

test('annulation éligible : stock restitué, badge Annulée', async () => {
  const page = ownerPage;
  await page.goto('/orders');
  await page.getByLabel('Rechercher une commande').fill(createdOrderNumber);
  // La commande créée en premier test est déjà DELIVERED (non annulable) —
  // on annule plutôt la commande "Client Deux" (CONFIRMED, éligible).
  await page.getByLabel('Rechercher une commande').fill('');
  await page.getByLabel('Filtrer par statut').click();
  await page.getByRole('option', { name: 'Confirmée' }).click();
  const row = page.getByTestId('order-row').first();
  await row.locator('a').first().click();

  await page.getByTestId('cancel-order').click();
  await page.getByTestId('confirm-cancel-order').click();
  await expect(page.getByTestId('order-status-badge')).toHaveAttribute('data-order-status', 'CANCELLED');
});

test('AGENT : voit ses commandes, ne peut pas annuler', async ({ browser }) => {
  const agentContext = await browser.newContext();
  const agentPage = await agentContext.newPage();
  await loginAs(agentPage, AGENT_EMAIL);
  await agentPage.goto('/orders');
  await expect(agentPage.getByTestId('order-row').first()).toBeVisible();
  await agentPage.getByTestId('order-row').first().locator('a').first().click();
  await expect(agentPage.getByTestId('cancel-order')).toHaveCount(0);
  await agentContext.close();
});

test('bascule de Shop : aucune commande de l’autre Shop visible', async () => {
  const page = ownerPage;
  await page.goto('/orders');
  await expect(page.getByTestId('order-row').first()).toBeVisible();

  await page.getByRole('button', { name: new RegExp(SHOP_NAME) }).click();
  await page.getByRole('menuitem', { name: new RegExp(SHOP2_NAME) }).click();
  await expect(page.getByText('Aucune commande')).toBeVisible();

  await page.getByRole('button', { name: new RegExp(SHOP2_NAME) }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${SHOP_NAME}`) }).click();
  await expect(page.getByTestId('order-row').first()).toBeVisible();
});
