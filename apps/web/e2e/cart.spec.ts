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
 * Panier conversationnel de bout en bout : vraie API, vrai worker (sweep
 * d'expiration), build de production du front.
 */
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'playwright-pass-123';
const OWNER_EMAIL = `pw-cart-${RUN_ID}-owner@e2e.whauto.test`;
const AGENT_EMAIL = `pw-cart-${RUN_ID}-agent@e2e.whauto.test`;
const ORG_NAME = `PW Cart Org ${RUN_ID}`;
const SHOP_NAME = `PW Cart Shop ${RUN_ID}`;
const SHOP2_NAME = `PW Cart Shop Bis ${RUN_ID}`;
const PRODUCT_NAME = `Robe Élégance ${RUN_ID}`;
const PRODUCT2_NAME = `Sac Classique ${RUN_ID}`;

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
let robeProductId: string;
let robeVariantId: string;

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

async function openCartTab(page: Page) {
  await page.goto('/conversations');
  await page.getByTestId('conversation-row').first().click();
  await page.getByRole('button', { name: 'Afficher la fiche contact' }).click();
  await page.getByTestId('tab-cart').click();
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
      CART_EXPIRATION_SWEEP_INTERVAL_SECONDS: '2',
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

  // Deux produits actifs (Robe avec tailles, Sac simple).
  const robeRes = await request.post(`${API}/organizations/${orgId}/shops/${shopId}/products`, {
    headers: auth,
    data: {
      name: PRODUCT_NAME,
      options: [{ name: 'Taille', values: ['M', 'L'] }],
      variants: [
        { sku: `ROBE-M-${RUN_ID}`, priceMinor: 25000, initialQuantity: 10, optionSelections: [{ optionName: 'Taille', value: 'M' }] },
        { sku: `ROBE-L-${RUN_ID}`, priceMinor: 25000, initialQuantity: 10, optionSelections: [{ optionName: 'Taille', value: 'L' }] },
      ],
    },
  });
  const robe = (await robeRes.json()) as { id: string; variants: Array<{ id: string; sku: string }> };
  robeProductId = robe.id;
  // SKU normalisé trim + MAJUSCULES côté serveur — comparaison insensible à la casse.
  robeVariantId = robe.variants.find(
    (v) => v.sku.toUpperCase() === `ROBE-M-${RUN_ID}`.toUpperCase(),
  )!.id;
  // Stock > seuil (5 par défaut) : pas d'avertissement stock faible dans le picker.
  const sacRes = await request.post(`${API}/organizations/${orgId}/shops/${shopId}/products`, {
    headers: auth,
    data: { name: PRODUCT2_NAME, variants: [{ sku: `SAC-${RUN_ID}`, priceMinor: 10000, initialQuantity: 12 }] },
  });
  const sac = (await sacRes.json()) as { id: string };
  for (const productId of [robe.id, sac.id]) {
    await request.post(`${API}/organizations/${orgId}/shops/${shopId}/products/${productId}/activate`, {
      headers: auth,
    });
  }

  const chanRes = await request.post(
    `${API}/organizations/${orgId}/shops/${shopId}/whatsapp-channel/mock`,
    { headers: auth, data: { displayName: 'Cart WA', phoneNumber: '+237659200001' } },
  );
  channelId = ((await chanRes.json()) as { id: string }).id;
  await request.post(`${API}/dev/whatsapp/mock/inbound`, {
    data: { channelId, phone: '+237659300001', displayName: 'Cliente Panier', text: 'Je veux la robe rouge' },
  });

  ownerContext = await browser.newContext();
  ownerPage = await ownerContext.newPage();
  await loginAs(ownerPage, OWNER_EMAIL);
});

test.afterAll(async () => {
  await ownerContext?.close();
  worker?.kill();
});

test('ajouter un produit avec choix de variante depuis l’onglet Panier', async () => {
  const page = ownerPage;
  await openCartTab(page);

  await page.getByTestId('cart-add-product').click();
  await page.getByLabel('Rechercher un produit').fill(PRODUCT_NAME);
  await page.getByTestId('picker-product').first().click();
  await page.getByTestId('picker-variant').filter({ hasText: `ROBE-M-${RUN_ID}` }).click();
  await expect(page.getByTestId('product-card-preview')).toBeVisible();
  await page.getByTestId('picker-insert').click(); // « Ajouter au panier »

  const panel = page.getByTestId('cart-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('cart-line')).toHaveCount(1);
  await expect(panel.getByTestId('cart-line').first()).toContainText(PRODUCT_NAME);
  await expect(panel.getByTestId('cart-total')).toContainText('25');
});

test('modifier la quantité et ajouter un second article — totaux serveur', async () => {
  const page = ownerPage;
  const panel = page.getByTestId('cart-panel');

  await panel.getByRole('button', { name: 'Augmenter la quantité' }).click();
  await expect(panel.getByTestId('line-quantity').first()).toHaveText('2');
  await expect(panel.getByTestId('cart-total')).toContainText('50');

  await panel.getByTestId('cart-add-product').click();
  await page.getByLabel('Rechercher un produit').fill(PRODUCT2_NAME);
  await page.getByTestId('picker-product').first().click();
  // Produit simple : variante par défaut directe.
  await page.getByTestId('picker-variant').first().click();
  await page.getByTestId('picker-insert').click();
  await expect(panel.getByTestId('cart-line')).toHaveCount(2);
  await expect(panel.getByTestId('cart-total')).toContainText('60'); // 50 000 + 10 000
});

test('retirer une ligne', async () => {
  const page = ownerPage;
  const panel = page.getByTestId('cart-panel');
  await panel.getByRole('button', { name: `Retirer ${PRODUCT2_NAME}` }).click();
  await expect(panel.getByTestId('cart-line')).toHaveCount(1);
});

test('résumé : inséré dans le composer, JAMAIS envoyé automatiquement', async () => {
  const page = ownerPage;
  await page.getByTestId('cart-summary').click();
  await expect(page.getByText('Résumé inséré dans le message')).toBeVisible();

  const composer = page.getByTestId('composer-input');
  await expect(composer).toHaveValue(/Votre panier :/);
  await expect(composer).toHaveValue(new RegExp(`${PRODUCT_NAME}.*× 2`));
  await expect(composer).toHaveValue(/Livraison : à définir/);
  // Aucun message parti sans clic explicite.
  await expect(page.getByTestId('message-outbound')).toHaveCount(0);

  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('message-outbound').last()).toContainText('Votre panier');
});

test('prix modifié : alerte + acceptation EXPLICITE du nouveau prix', async () => {
  const page = ownerPage;
  const panel = page.getByTestId('cart-panel');
  // Prix catalogue modifié en coulisse.
  await ownerPage.request.patch(
    `${API}/organizations/${orgId}/shops/${shopId}/products/${robeProductId}/variants/${robeVariantId}`,
    { headers: { Authorization: `Bearer ${ownerToken}` }, data: { priceMinor: 27000 } },
  );

  await panel.getByTestId('cart-revalidate').click();
  await expect(panel.getByTestId('line-alert')).toBeVisible();
  await expect(panel.getByTestId('line-alert')).toContainText('Prix modifié');

  await panel.getByTestId('accept-price').click();
  await expect(panel.getByTestId('line-alert')).toHaveCount(0);
  await expect(panel.getByTestId('cart-total')).toContainText('54'); // 27 000 × 2
});

test('checkout : démarrer, voir la réservation, remplir DELIVERY, paiement à la livraison, confirmer', async () => {
  const page = ownerPage;
  const panel = page.getByTestId('cart-panel');

  await panel.getByTestId('checkout-start').click();
  await expect(panel.getByTestId('checkout-form')).toBeVisible();
  await expect(panel.getByTestId('reservation-countdown').first()).toContainText('Réservé encore');

  await panel.getByLabel('Nom du client').fill('Cliente Panier');
  await panel.getByTestId('fulfillment-select').click();
  await page.getByRole('option', { name: 'Livraison' }).click();
  await panel.getByLabel('Ville').fill('Douala');
  await panel.getByLabel('Adresse', { exact: true }).fill('Rue des Cocotiers 12');
  await panel.getByTestId('payment-select').click();
  await page.getByRole('option', { name: 'Paiement à la livraison' }).click();
  await panel.getByTestId('checkout-save').click();
  await expect(panel.getByText('Prêt à confirmer')).toBeVisible();

  await panel.getByTestId('checkout-confirm').click();
  await expect(panel.getByTestId('checkout-confirmed')).toBeVisible();
  await expect(panel.getByTestId('checkout-confirmed')).toContainText('prêt pour la commande');
  await expect(panel.getByTestId('checkout-confirmed')).toContainText('Livraison');
});

test('deux agents voient le panier en temps réel', async ({ browser, request }) => {
  // Nouvelle conversation pour un panier frais.
  await request.post(`${API}/dev/whatsapp/mock/inbound`, {
    data: { channelId, phone: '+237659300002', displayName: 'Client Deux', text: 'Bonjour' },
  });

  const agentContext = await browser.newContext();
  const agentPage = await agentContext.newPage();
  await loginAs(agentPage, AGENT_EMAIL);
  await agentPage.goto('/conversations');
  await agentPage.getByTestId('conversation-row').filter({ hasText: 'Client Deux' }).click();
  await agentPage.getByRole('button', { name: 'Afficher la fiche contact' }).click();
  await agentPage.getByTestId('tab-cart').click();

  // L'owner ouvre la même conversation, côté panier aussi.
  const page = ownerPage;
  await page.goto('/conversations');
  await page.getByTestId('conversation-row').filter({ hasText: 'Client Deux' }).click();
  await page.getByRole('button', { name: 'Afficher la fiche contact' }).click();
  await page.getByTestId('tab-cart').click();

  // L'AGENT ajoute un produit — l'owner voit la ligne arriver en temps réel.
  await agentPage.getByTestId('cart-add-product').click();
  await agentPage.getByLabel('Rechercher un produit').fill(PRODUCT2_NAME);
  await agentPage.getByTestId('picker-product').first().click();
  await agentPage.getByTestId('picker-variant').first().click();
  await agentPage.getByTestId('picker-insert').click();

  await expect(page.getByTestId('cart-panel').getByTestId('cart-line')).toHaveCount(1, {
    timeout: 15000,
  });
  await expect(page.getByTestId('cart-panel')).toContainText(PRODUCT2_NAME);

  await agentContext.close();
});

test('checkout démarré puis annulé : réservation affichée, puis libérée et compte à rebours disparu', async () => {
  // L'expiration réelle par le sweep worker est prouvée côté e2e API (base
  // manipulée directement) — ici on vérifie le cycle réserver/libérer via l'UI.
  const page = ownerPage;
  const panel = page.getByTestId('cart-panel');
  await panel.getByTestId('checkout-start').click();
  await expect(panel.getByTestId('checkout-form')).toBeVisible();
  await expect(panel.getByTestId('reservation-countdown').first()).toContainText('Réservé encore');

  await panel.getByTestId('checkout-cancel').click();
  await expect(panel.getByTestId('checkout-start')).toBeVisible({ timeout: 10000 });
  await expect(panel.getByTestId('reservation-countdown')).toHaveCount(0);
});

/**
 * AI-C / W3 — le différenciateur de bout en bout : un message CLIENT déclenche
 * un run IA qui appelle l'outil WRITE `add_to_cart`, et l'agent voit la ligne
 * apparaître dans le panneau Panier, marquée comme venant de l'assistant.
 * Pipeline RÉELLE (API + worker + MockAiProvider déterministe) — le mock ne
 * décide que QUEL outil appeler ; la mutation, elle, passe par le vrai cœur.
 */
test('l’assistant ajoute au panier depuis la conversation (ligne marquée « Ajouté par l’assistant »)', async ({
  request,
}) => {
  const auth = { Authorization: `Bearer ${ownerToken}` };

  // Un run IA consomme des crédits : achat d'un pack via le paiement MOCK
  // (le Wallet reste la seule source de vérité des crédits).
  const packages = await request.get(`${API}/organizations/${orgId}/wallet/packages`, {
    headers: auth,
  });
  const packageId = ((await packages.json()) as { items: Array<{ id: string }> }).items[0].id;
  const topUp = await request.post(`${API}/organizations/${orgId}/wallet/top-ups`, {
    headers: auth,
    data: { creditPackageId: packageId },
  });
  expect(topUp.status()).toBe(201);
  const topUpId = ((await topUp.json()) as { topUp: { id: string } }).topUp.id;
  const confirmed = await request.post(
    `${API}/organizations/${orgId}/wallet/top-ups/${topUpId}/mock-confirm`,
    { headers: auth },
  );
  expect(confirmed.status()).toBe(201);

  const config = await request.get(
    `${API}/organizations/${orgId}/shops/${shopId}/ai/configuration`,
    { headers: auth },
  );
  const { version, cartToolsEnabled } = (await config.json()) as {
    version: number;
    cartToolsEnabled: boolean;
  };
  // Défaut serveur : les outils panier sont exposés sans rien activer.
  expect(cartToolsEnabled).toBe(true);
  const patch = await request.patch(`${API}/organizations/${orgId}/shops/${shopId}/ai/configuration`, {
    headers: auth,
    data: { mode: 'SUGGEST_ONLY', provider: 'MOCK', expectedVersion: version },
  });
  expect(patch.status()).toBe(200);

  // Nouveau client : conversation vierge, aucun panier existant.
  await request.post(`${API}/dev/whatsapp/mock/inbound`, {
    data: {
      channelId,
      phone: '+237659300009',
      displayName: 'Cliente IA',
      text: `!ai-cart ${robeVariantId}`,
    },
  });

  const page = ownerPage;
  await openCartTab(page);

  // La ligne créée par l'IA apparaît, marquée — et reste modifiable par l'agent.
  await expect(page.getByTestId('cart-line-ai-badge')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('cart-line')).toHaveCount(1);
  await expect(page.getByTestId('line-quantity')).toHaveText('1');
});

test('bascule de Shop : aucun panier ni conversation de l’autre Shop', async () => {
  const page = ownerPage;
  await page.goto('/conversations');
  await expect(page.getByTestId('conversation-row').first()).toBeVisible();
  await page.getByRole('button', { name: new RegExp(SHOP_NAME) }).click();
  await page.getByRole('menuitem', { name: new RegExp(SHOP2_NAME) }).click();
  await expect(page.getByText('Connecter WhatsApp')).toBeVisible();
  await page.getByRole('button', { name: new RegExp(SHOP2_NAME) }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${SHOP_NAME}`) }).click();
  await expect(page.getByTestId('conversation-row').first()).toBeVisible();
});
