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
 * Crédits / Wallet de bout en bout : vraie API, vrai worker (MockAiProvider),
 * build de production du front. Raconte le cycle complet du module :
 *   1. solde 0 → l'assistant IA ne répond pas et l'inbox invite à recharger ;
 *   2. achat d'un pack (paiement MOCK) → le solde est crédité, aiAvailable=true ;
 *   3. nouvel inbound → l'IA génère et des crédits sont RÉELLEMENT consommés ;
 *   4. le solde se met à jour EN TEMPS RÉEL dans un second onglet après un achat.
 */
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'playwright-pass-123';
const OWNER_EMAIL = `pw-wallet-${RUN_ID}-owner@e2e.whauto.test`;
const ORG_NAME = `PW Wallet Org ${RUN_ID}`;
const SHOP_NAME = `PW Wallet Shop ${RUN_ID}`;

const API = 'http://localhost:4000/api';
const WORKER_DIST = resolve(__dirname, '../../whatsapp-worker/dist/main.js');

test.describe.configure({ mode: 'serial' });

let worker: ChildProcess;
let ownerContext: BrowserContext;
let ownerPage: Page;
let ownerToken: string;
let orgId: string;
let channelId: string;

async function registerVerifiedUser(request: APIRequestContext, userEmail: string, lastName: string) {
  const res = await request.post(`${API}/auth/register`, {
    data: { email: userEmail, password: PASSWORD, firstName: 'Playwright', lastName },
  });
  expect(res.status()).toBe(201);
  const { devLink } = (await res.json()) as { devLink: string };
  await request.post(`${API}/auth/verify-email`, {
    data: { token: new URL(devLink).searchParams.get('token')! },
  });
}

async function apiLogin(request: APIRequestContext, userEmail: string): Promise<string> {
  const res = await request.post(`${API}/auth/login`, { data: { email: userEmail, password: PASSWORD } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function loginAs(page: Page, userEmail: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(userEmail);
  await page.getByRole('textbox', { name: 'Mot de passe' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function sendInbound(request: APIRequestContext, phone: string, text: string) {
  await request.post(`${API}/dev/whatsapp/mock/inbound`, {
    data: { channelId, phone, displayName: `Client ${phone.slice(-4)}`, text },
  });
}

/** Solde disponible tel qu'exposé par l'API (source de vérité, hors UI). */
async function availableCredits(request: APIRequestContext): Promise<number> {
  const res = await request.get(`${API}/organizations/${orgId}/wallet`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  return ((await res.json()) as { availableCredits: number }).availableCredits;
}

test.beforeAll(async ({ browser, request }) => {
  test.skip(!existsSync(WORKER_DIST), 'Worker non buildé');

  worker = spawn(process.execPath, [WORKER_DIST], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'fatal',
      REDIS_URL: 'redis://localhost:6379/1',
      AI_MODE: 'SUGGEST_ONLY',
      AI_PROVIDER: 'MOCK',
      AI_DEBOUNCE_MS: '500',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://whauto:whauto@localhost:5433/whauto_dev',
    },
    stdio: 'ignore',
  });

  await registerVerifiedUser(request, OWNER_EMAIL, 'Owner');
  ownerToken = await apiLogin(request, OWNER_EMAIL);
  const auth = { Authorization: `Bearer ${ownerToken}` };

  const orgRes = await request.post(`${API}/organizations`, { headers: auth, data: { name: ORG_NAME } });
  orgId = ((await orgRes.json()) as { organization: { id: string } }).organization.id;

  const shopRes = await request.post(`${API}/organizations/${orgId}/shops`, {
    headers: auth,
    data: { name: SHOP_NAME, countryCode: 'CM' },
  });
  const shopId = ((await shopRes.json()) as { id: string }).id;

  const chanRes = await request.post(
    `${API}/organizations/${orgId}/shops/${shopId}/whatsapp-channel/mock`,
    { headers: auth, data: { displayName: 'Wallet WA', phoneNumber: '+237659700010' } },
  );
  channelId = ((await chanRes.json()) as { id: string }).id;

  await request.patch(`${API}/organizations/${orgId}/shops/${shopId}/ai/configuration`, {
    headers: auth,
    data: { mode: 'SUGGEST_ONLY', provider: 'MOCK', expectedVersion: 0 },
  });

  ownerContext = await browser.newContext();
  ownerPage = await ownerContext.newPage();
  await loginAs(ownerPage, OWNER_EMAIL);
});

test.afterAll(async () => {
  await ownerContext?.close();
  worker?.kill();
});

async function openConversationByText(page: Page, snippet: string) {
  await page.goto('/conversations');
  await page.getByTestId('conversation-row').filter({ hasText: snippet }).first().click();
}

test('solde 0 : la page Crédits affiche l’avertissement IA indisponible', async () => {
  const page = ownerPage;
  await page.goto('/billing');
  await expect(page.getByTestId('wallet-balance-card')).toBeVisible();
  await expect(page.getByTestId('wallet-available')).toHaveText(/0/);
  await expect(page.getByTestId('ai-unavailable')).toBeVisible();
});

test('solde 0 : un inbound ne génère AUCUNE suggestion, l’inbox invite à recharger', async ({ request }) => {
  const page = ownerPage;
  await sendInbound(request, '+237659820001', 'Bonjour, avez-vous des sacs rouges ?');
  await openConversationByText(page, '+237659820001'.slice(-4));

  // Le worker a SKIPPÉ (crédits insuffisants) : jamais de suggestion, et le
  // panneau propose de recharger.
  await expect(page.getByTestId('ai-insufficient-credits')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('ai-suggestion-text')).toHaveCount(0);
  // Le lien pointe vers la page Crédits.
  await expect(page.getByTestId('ai-insufficient-credits')).toHaveAttribute('href', '/billing');
});

test('achat d’un pack (paiement MOCK) crédite le Wallet et réactive l’IA', async () => {
  const page = ownerPage;
  await page.goto('/billing');
  await expect(page.getByTestId('credit-packages')).toBeVisible();

  await page.getByTestId('buy-package').first().click();

  // Paiement simulé confirmé → solde crédité, badge « Assistant IA actif ».
  await expect(page.getByTestId('ai-available')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('wallet-available')).not.toHaveText(/^0$/);
  // Le ledger porte l'achat de crédits.
  await expect(
    page.getByTestId('wallet-transactions').getByText('Achat de crédits'),
  ).toBeVisible({ timeout: 10000 });
});

test('crédits disponibles : un nouvel inbound génère une suggestion ET consomme des crédits', async ({ request }) => {
  const page = ownerPage;
  const before = await availableCredits(request);
  expect(before).toBeGreaterThanOrEqual(3);

  await sendInbound(request, '+237659820002', 'Bonjour, quels sont vos horaires ?');
  await openConversationByText(page, '+237659820002'.slice(-4));

  // L'IA répond de nouveau (pipeline worker réel) — plus de blocage crédits.
  await expect(page.getByTestId('ai-suggestion-text')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('ai-suggestion-text')).not.toHaveValue('');

  // Des crédits ont RÉELLEMENT été consommés (débit du run facturé).
  await expect
    .poll(() => availableCredits(request), { timeout: 15000, intervals: [500, 1000, 2000] })
    .toBeLessThan(before);
});

test('temps réel : un achat dans un onglet met à jour le solde dans un second onglet', async () => {
  const page = ownerPage;
  const secondPage = await ownerContext.newPage();
  await secondPage.goto('/billing');
  await expect(secondPage.getByTestId('wallet-available')).toBeVisible();
  const initial = Number((await secondPage.getByTestId('wallet-available').innerText()).replace(/\D/g, ''));

  // Achat dans le premier onglet.
  await page.goto('/billing');
  await page.getByTestId('buy-package').first().click();
  await expect(page.getByTestId('wallet-transactions').getByText('Achat de crédits').first()).toBeVisible({
    timeout: 10000,
  });

  // Le second onglet reçoit wallet.balance.updated (socket) et se rafraîchit
  // SANS rechargement — le solde augmente.
  await expect
    .poll(
      async () => Number((await secondPage.getByTestId('wallet-available').innerText()).replace(/\D/g, '')),
      { timeout: 15000, intervals: [500, 1000, 2000] },
    )
    .toBeGreaterThan(initial);

  await secondPage.close();
});
