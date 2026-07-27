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
 * Catalogue de bout en bout : vraie API, build de production du front, et
 * worker réel pour la partie inbox (sélection produit depuis une conversation).
 */
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'playwright-pass-123';
const OWNER_EMAIL = `pw-cat-${RUN_ID}-owner@e2e.whauto.test`;
const AGENT_EMAIL = `pw-cat-${RUN_ID}-agent@e2e.whauto.test`;
const ORG_NAME = `PW Cat Org ${RUN_ID}`;
const SHOP_NAME = `PW Cat Shop ${RUN_ID}`;
const SHOP2_NAME = `PW Cat Shop Bis ${RUN_ID}`;
const CATEGORY_NAME = `Sneakers ${RUN_ID}`;
const SIMPLE_NAME = `Casquette ${RUN_ID}`;
const MULTI_NAME = `Tee-shirt ${RUN_ID}`;

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
  const token = new URL(devLink).searchParams.get('token')!;
  await request.post(`${API}/auth/verify-email`, { data: { token } });
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
      WHATSAPP_MOCK_DELIVERY_DELAY_MS: '500',
      WHATSAPP_MOCK_READ_DELAY_MS: '500',
    },
    stdio: 'ignore',
  });

  await registerVerifiedUser(request, OWNER_EMAIL, 'Owner');
  await registerVerifiedUser(request, AGENT_EMAIL, 'Agent');
  ownerToken = await apiLogin(request, OWNER_EMAIL);
  const auth = { Authorization: `Bearer ${ownerToken}` };

  const orgRes = await request.post(`${API}/organizations`, {
    headers: auth,
    data: { name: ORG_NAME },
  });
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

  // Canal WhatsApp mock + conversation (pour le test d'intégration inbox).
  const chanRes = await request.post(
    `${API}/organizations/${orgId}/shops/${shopId}/whatsapp-channel/mock`,
    { headers: auth, data: { displayName: 'Cat WA', phoneNumber: '+237651117777' } },
  );
  channelId = ((await chanRes.json()) as { id: string }).id;
  await request.post(`${API}/dev/whatsapp/mock/inbound`, {
    data: {
      channelId,
      phone: '+237652228888',
      displayName: 'Client Catalogue',
      text: 'Avez-vous des tee-shirts ?',
    },
  });

  ownerContext = await browser.newContext();
  ownerPage = await ownerContext.newPage();
  await loginAs(ownerPage, OWNER_EMAIL);
});

test.afterAll(async () => {
  await ownerContext?.close();
  worker?.kill();
});

test('créer une catégorie depuis l’UI', async () => {
  const page = ownerPage;
  await page.goto('/categories');
  await page.getByRole('button', { name: 'Nouvelle catégorie' }).click();
  await page.getByLabel('Nom').fill(CATEGORY_NAME);
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await expect(page.getByRole('cell', { name: CATEGORY_NAME, exact: true })).toBeVisible();
});

test('créer un produit simple avec prix et stock, puis l’activer', async () => {
  const page = ownerPage;
  await page.goto('/products/new');

  await page.getByLabel('Nom', { exact: true }).fill(SIMPLE_NAME);
  await page.getByLabel('Catégorie').click();
  await page.getByRole('option', { name: CATEGORY_NAME }).click();

  const row = page.getByTestId('variant-draft-row').first();
  await row.getByLabel('SKU').fill(`CASQ-${RUN_ID}`);
  await row.getByLabel(/^Prix \(/).fill('7500');
  await row.getByLabel('Stock initial').fill('12');
  await page.getByRole('button', { name: 'Créer le produit' }).click();

  // Redirection vers le détail ; activation.
  await expect(page.getByRole('heading', { name: new RegExp(SIMPLE_NAME) })).toBeVisible();
  await page.getByRole('button', { name: 'Activer', exact: true }).click();
  await expect(page.getByText('Produit activé.')).toBeVisible();
});

test('le produit apparaît dans le catalogue avec prix, stock et disponibilité', async () => {
  const page = ownerPage;
  await page.goto('/products');
  const row = page.getByTestId('product-row').filter({ hasText: SIMPLE_NAME });
  await expect(row).toBeVisible();
  await expect(row).toContainText('7 500');
  await expect(row.getByTestId('stock-status-badge')).toHaveAttribute(
    'data-stock-status',
    'IN_STOCK',
  );
});

test('créer un produit multi-variantes : combinaisons générées, prix et stock par variante', async () => {
  const page = ownerPage;
  await page.goto('/products/new');
  await page.getByLabel('Nom', { exact: true }).fill(MULTI_NAME);

  await page.getByLabel('Ce produit a des déclinaisons').click();
  await page.getByRole('textbox', { name: 'Option 1' }).fill('Taille');
  await page.getByLabel('Valeurs (séparées par des virgules)').fill('S, M');
  await page.getByLabel('Valeurs (séparées par des virgules)').blur();

  // 2 combinaisons générées (S, M).
  await expect(page.getByTestId('variant-draft-row')).toHaveCount(2);

  const rows = page.getByTestId('variant-draft-row');
  await rows.nth(0).getByLabel('SKU').fill(`TEE-S-${RUN_ID}`);
  await rows.nth(0).getByLabel(/^Prix \(/).fill('9000');
  await rows.nth(0).getByLabel('Stock initial').fill('3');
  await rows.nth(1).getByLabel('SKU').fill(`TEE-M-${RUN_ID}`);
  await rows.nth(1).getByLabel(/^Prix \(/).fill('9500');
  await rows.nth(1).getByLabel('Stock initial').fill('0');

  await page.getByRole('button', { name: 'Créer le produit' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(MULTI_NAME) })).toBeVisible();
  await expect(page.getByTestId('variant-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Activer', exact: true }).click();
  await expect(page.getByText('Produit activé.')).toBeVisible();
});

test('filtrer par catégorie et rechercher par SKU', async () => {
  const page = ownerPage;
  await page.goto('/products');

  await page.getByLabel('Filtrer par catégorie').click();
  await page.getByRole('option', { name: CATEGORY_NAME }).click();
  await expect(page.getByTestId('product-row')).toHaveCount(1);
  await expect(page.getByTestId('product-row').first()).toContainText(SIMPLE_NAME);

  await page.getByLabel('Filtrer par catégorie').click();
  await page.getByRole('option', { name: 'Toutes catégories' }).click();
  await page.getByLabel('Rechercher un produit').fill(`TEE-M-${RUN_ID}`);
  await expect(page.getByTestId('product-row')).toHaveCount(1);
  await expect(page.getByTestId('product-row').first()).toContainText(MULTI_NAME);
});

test('ajuster le stock avec aperçu avant/après, puis voir le mouvement', async () => {
  const page = ownerPage;
  await page.goto('/inventory');

  const row = page.getByTestId('inventory-row').filter({ hasText: `CASQ-${RUN_ID}` });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /Ajuster/ }).click();

  await page.getByLabel(/Quantité ajoutée/).fill('8');
  await expect(page.getByTestId('adjust-preview')).toContainText('12 → 20');
  await page.getByRole('button', { name: 'Confirmer l’ajustement' }).click();
  await expect(page.getByText('Stock ajusté : 12 → 20.')).toBeVisible();

  // Historique : mouvement RESTOCK visible.
  await row.getByRole('button', { name: /Historique/ }).click();
  const movements = page.getByTestId('movement-row');
  await expect(movements.first()).toContainText('Réappro');
  await expect(movements.first()).toContainText('+8');
  await page.keyboard.press('Escape');
});

test('filtrer le stock faible', async () => {
  const page = ownerPage;
  await page.goto('/inventory');
  await page.getByRole('button', { name: 'Stock faible' }).click();
  // TEE-S (3 ≤ seuil 5) est en stock faible.
  await expect(page.getByTestId('inventory-row').filter({ hasText: `TEE-S-${RUN_ID}` })).toBeVisible();
  await expect(
    page.getByTestId('inventory-row').filter({ hasText: `CASQ-${RUN_ID}` }),
  ).toHaveCount(0);
});

test('sélectionner un produit depuis une conversation : revalidation + insertion composer', async () => {
  const page = ownerPage;
  await page.goto('/conversations');
  await page.getByTestId('conversation-row').first().click();

  await page.getByTestId('add-product-button').click();
  await page.getByLabel('Rechercher un produit').fill(MULTI_NAME);
  await page.getByTestId('picker-product').first().click();

  // Choix de variante (2 actives) puis prévisualisation revalidée.
  await page.getByTestId('picker-variant').filter({ hasText: `TEE-S-${RUN_ID}` }).click();
  await expect(page.getByTestId('product-card-preview')).toBeVisible();
  await expect(page.getByTestId('product-card-preview')).toContainText('9 000');
  await expect(page.getByText('données revalidées à l’instant')).toBeVisible();

  // Stock faible (3 ≤ 5) : avertissement + confirmation exigée avant insertion.
  await expect(page.getByTestId('picker-stock-warning')).toBeVisible();
  await expect(page.getByTestId('picker-insert')).toBeDisabled();
  await page.getByRole('button', { name: 'J’ai compris' }).click();
  await page.getByTestId('picker-insert').click();

  // Le composer est PRÉREMPLI — rien n'est envoyé automatiquement.
  const composer = page.getByTestId('composer-input');
  await expect(composer).toHaveValue(new RegExp(`${MULTI_NAME}.*9.?000.*Stock faible`));
  await expect(page.getByTestId('message-outbound')).toHaveCount(0);

  // L'envoi reste l'action explicite de l'agent.
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('message-outbound').last()).toContainText(MULTI_NAME);
});

test('archiver le produit simple depuis sa fiche', async () => {
  const page = ownerPage;
  await page.goto('/products');
  await page.getByTestId('product-row').filter({ hasText: SIMPLE_NAME }).getByRole('link').first().click();
  await page.getByRole('button', { name: 'Archiver' }).first().click();
  await page.getByRole('button', { name: 'Archiver', exact: true }).click();
  await expect(page.getByText('Produit archivé (variantes incluses).')).toBeVisible();
  await page.goto('/products');
  await expect(page.getByTestId('product-row').filter({ hasText: SIMPLE_NAME })).toHaveCount(0);
});

test('bascule de Shop : aucun produit de l’ancienne Shop visible', async () => {
  const page = ownerPage;
  await page.goto('/products');
  await expect(page.getByTestId('product-row').first()).toBeVisible();

  await page.getByRole('button', { name: new RegExp(SHOP_NAME) }).click();
  await page.getByRole('menuitem', { name: new RegExp(SHOP2_NAME) }).click();
  await expect(page.getByText('Aucun produit')).toBeVisible();
  await expect(page.getByTestId('product-row')).toHaveCount(0);

  await page.getByRole('button', { name: new RegExp(SHOP2_NAME) }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${SHOP_NAME}`) }).click();
  await expect(page.getByTestId('product-row').first()).toBeVisible();
});

test('AGENT : catalogue en lecture seule (aucune création, aucun ajustement, coût masqué)', async ({
  browser,
}) => {
  const agentContext = await browser.newContext();
  const agentPage = await agentContext.newPage();
  await loginAs(agentPage, AGENT_EMAIL);

  await agentPage.goto('/products');
  await expect(agentPage.getByTestId('product-row').first()).toBeVisible();
  await expect(agentPage.getByRole('link', { name: 'Nouveau produit' })).toHaveCount(0);

  await agentPage.getByTestId('product-row').first().getByRole('link').first().click();
  await expect(agentPage.getByRole('button', { name: 'Activer', exact: true })).toHaveCount(0);
  await expect(agentPage.getByRole('cell', { name: 'Coût' })).toHaveCount(0);

  await agentPage.goto('/inventory');
  await expect(agentPage.getByTestId('inventory-row').first()).toBeVisible();
  await expect(agentPage.getByRole('button', { name: /Ajuster/ })).toHaveCount(0);
  await expect(agentPage.getByRole('button', { name: /Historique/ })).toHaveCount(0);

  await agentContext.close();
});
