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
 * AUTO_REPLY de bout en bout (sous-phase C) : vraie API, vrai worker
 * (MockAiProvider), build de production du front. Le MockAiProvider renvoie un
 * SUGGEST_REPLY sans affirmation factuelle (confidence 0.9, aucun outil) → le
 * gate déterministe AUTO-ENVOIE. On vérifie : bulle « Réponse IA » violette +
 * badge actif ; pause → une nouvelle question devient une SUGGESTION (aucun
 * auto-envoi) ; reprise ; réglages IA côté Shop.
 */
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'playwright-pass-123';
const OWNER_EMAIL = `pw-auto-${RUN_ID}-owner@e2e.whauto.test`;
const ORG_NAME = `PW Auto Org ${RUN_ID}`;
const SHOP_NAME = `PW Auto Shop ${RUN_ID}`;

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

/** Achète un pack de crédits (paiement MOCK) — un run IA sans solde est SKIPPED. */
async function buyCredits(request: APIRequestContext, auth: Record<string, string>) {
  const packages = await request.get(`${API}/organizations/${orgId}/wallet/packages`, {
    headers: auth,
  });
  const creditPackageId = ((await packages.json()) as { items: Array<{ id: string }> }).items[0].id;
  const topUp = await request.post(`${API}/organizations/${orgId}/wallet/top-ups`, {
    headers: auth,
    data: { creditPackageId },
  });
  const topUpId = ((await topUp.json()) as { topUp: { id: string } }).topUp.id;
  const confirmed = await request.post(
    `${API}/organizations/${orgId}/wallet/top-ups/${topUpId}/mock-confirm`,
    { headers: auth },
  );
  expect(confirmed.status()).toBe(201);
}

test.beforeAll(async ({ browser, request }) => {
  test.skip(!existsSync(WORKER_DIST), 'Worker non buildé');

  worker = spawn(process.execPath, [WORKER_DIST], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'fatal',
      REDIS_URL: 'redis://localhost:6379/1',
      AI_MODE: 'AUTO_REPLY',
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
  shopId = ((await shopRes.json()) as { id: string }).id;

  const chanRes = await request.post(
    `${API}/organizations/${orgId}/shops/${shopId}/whatsapp-channel/mock`,
    { headers: auth, data: { displayName: 'Auto WA', phoneNumber: '+237659701001' } },
  );
  channelId = ((await chanRes.json()) as { id: string }).id;

  // Crédits : un run IA en réserve et en consomme (module Wallet) — sans solde
  // le run est SKIPPED (INSUFFICIENT_CREDITS) et rien n'est auto-envoyé.
  await buyCredits(request, auth);

  // AUTO_REPLY activé (mode + drapeau) — permission OWNER (ai.enableAutoReply).
  const patch = await request.patch(`${API}/organizations/${orgId}/shops/${shopId}/ai/configuration`, {
    headers: auth,
    data: { mode: 'AUTO_REPLY', autoReplyEnabled: true, provider: 'MOCK', expectedVersion: 0 },
  });
  expect(patch.status()).toBe(200);

  ownerContext = await browser.newContext();
  ownerPage = await ownerContext.newPage();
  await loginAs(ownerPage, OWNER_EMAIL);
});

test.afterAll(async () => {
  await ownerContext?.close();
  worker?.kill();
});

async function openFirstConversation(page: Page) {
  await page.goto('/conversations');
  await page.getByTestId('conversation-row').first().click();
}

test('l’IA répond automatiquement : bulle « Réponse IA » violette + badge actif', async ({ request }) => {
  await sendInbound(request, '+237659900001', 'Bonjour, une question générale');
  const page = ownerPage;
  await openFirstConversation(page);

  // Badge d'auto-réponse actif (la Shop est en AUTO_REPLY).
  await expect(page.getByTestId('auto-reply-badge')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('auto-reply-badge')).toHaveAttribute('data-paused', 'false');

  // Le worker a auto-envoyé : une bulle marquée IA apparaît (pipeline réelle).
  await expect(page.locator('[data-ai-message="true"]')).toBeVisible({ timeout: 20000 });
  await expect(page.getByText('Réponse IA')).toBeVisible();
});

test('la pause suspend l’auto-réponse : une nouvelle question devient une SUGGESTION', async ({ request }) => {
  const page = ownerPage;
  await sendInbound(request, '+237659900002', 'Première question');
  await openFirstConversation(page);

  // Auto-réponse au premier message.
  await expect(page.locator('[data-ai-message="true"]')).toBeVisible({ timeout: 20000 });
  const aiBefore = await page.locator('[data-ai-message="true"]').count();

  // Pause.
  await page.getByTestId('auto-reply-pause').click();
  await expect(page.getByTestId('auto-reply-badge')).toHaveAttribute('data-paused', 'true', {
    timeout: 10000,
  });

  // Nouvelle question du MÊME client → suppression → SUGGESTION (pas d'auto-envoi).
  await sendInbound(request, '+237659900002', 'Deuxième question');
  await expect(page.getByTestId('ai-suggestion-text')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-ai-message="true"]')).toHaveCount(aiBefore);

  // Reprise → badge de nouveau actif.
  await page.getByTestId('auto-reply-resume').click();
  await expect(page.getByTestId('auto-reply-badge')).toHaveAttribute('data-paused', 'false', {
    timeout: 10000,
  });
});

test('les réglages IA de la Shop affichent AUTO_REPLY et enregistrent un changement de sujet', async () => {
  const page = ownerPage;
  await page.goto(`/shops/${shopId}/settings`);

  const card = page.getByTestId('ai-config-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Réponse automatique');

  // Bascule d'un sujet auto-envoyable, puis enregistrement.
  const category = page.getByTestId('ai-category-ORDER_STATUS');
  await expect(category).toBeVisible();
  await category.click();
  await page.getByTestId('ai-config-save').click();
  await expect(page.getByText('Configuration IA enregistrée.')).toBeVisible({ timeout: 10000 });
});
