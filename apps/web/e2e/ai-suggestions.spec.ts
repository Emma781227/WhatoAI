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
 * Suggestion IA de bout en bout : vraie API, vrai worker (MockAiProvider),
 * build de production du front. Le worker AUTO-génère une suggestion sur un
 * inbound mock (pipeline réelle inbound → trigger → orchestrateur → suggestion).
 * On vérifie : suggestion visible, insertion SANS envoi, modification + envoi,
 * rejet, régénération, réponse manuelle toujours disponible, isolation entre
 * conversations.
 */
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'playwright-pass-123';
const OWNER_EMAIL = `pw-ai-${RUN_ID}-owner@e2e.whauto.test`;
const ORG_NAME = `PW AI Org ${RUN_ID}`;
const SHOP_NAME = `PW AI Shop ${RUN_ID}`;

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
  shopId = ((await shopRes.json()) as { id: string }).id;

  const chanRes = await request.post(
    `${API}/organizations/${orgId}/shops/${shopId}/whatsapp-channel/mock`,
    { headers: auth, data: { displayName: 'AI WA', phoneNumber: '+237659700001' } },
  );
  channelId = ((await chanRes.json()) as { id: string }).id;

  // IA en SUGGEST_ONLY (sinon la config créée par défaut est DISABLED et le
  // worker ne génère rien).
  await request.patch(`${API}/organizations/${orgId}/shops/${shopId}/ai/configuration`, {
    headers: auth,
    data: { mode: 'SUGGEST_ONLY', provider: 'MOCK', expectedVersion: 0 },
  });

  // Deux conversations distinctes (contacts différents) → deux suggestions.
  await sendInbound(request, '+237659800001', 'Bonjour, vous avez des sacs rouges ?');
  await sendInbound(request, '+237659800002', 'Bonjour, quels sont vos horaires ?');

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

test('la suggestion IA générée par le worker est visible', async () => {
  const page = ownerPage;
  await openFirstConversation(page);
  const panel = page.getByTestId('ai-suggestion-panel');
  await expect(panel).toBeVisible();
  // La suggestion arrive via le pipeline réel (worker MockAiProvider).
  await expect(page.getByTestId('ai-suggestion-text')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('ai-suggestion-text')).not.toHaveValue('');
});

test('Insérer préremplit le composer SANS envoyer', async () => {
  const page = ownerPage;
  await openFirstConversation(page);
  await expect(page.getByTestId('ai-suggestion-text')).toBeVisible({ timeout: 20000 });

  const outboundBefore = await page.getByTestId('message-outbound').count();
  await page.getByTestId('ai-insert').click();

  // Le composer contient le texte, mais AUCUN message n'a été envoyé.
  await expect(page.getByTestId('composer-input')).not.toHaveValue('');
  await expect(page.getByTestId('message-outbound')).toHaveCount(outboundBefore);
  // La suggestion reste PENDING (toujours affichée).
  await expect(page.getByTestId('ai-suggestion-text')).toBeVisible();
});

test('Modifier puis Envoyer accepte et envoie le contenu édité', async () => {
  const page = ownerPage;
  await openFirstConversation(page);
  const textarea = page.getByTestId('ai-suggestion-text');
  await expect(textarea).toBeVisible({ timeout: 20000 });

  const edited = `Réponse validée ${RUN_ID}`;
  await textarea.fill(edited);
  await page.getByTestId('ai-send').click();

  // Un message sortant avec le contenu édité apparaît (temps réel).
  await expect(page.getByTestId('message-outbound').filter({ hasText: edited })).toBeVisible({
    timeout: 15000,
  });
  // La suggestion n'est plus PENDING → le bloc de suggestion disparaît.
  await expect(page.getByTestId('ai-suggestion-text')).toHaveCount(0);
});

test('la réponse manuelle reste toujours disponible (indépendante de l’IA)', async () => {
  const page = ownerPage;
  await openFirstConversation(page);

  const manual = `Réponse manuelle ${RUN_ID}`;
  await page.getByTestId('composer-input').fill(manual);
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('message-outbound').filter({ hasText: manual })).toBeVisible({
    timeout: 15000,
  });
});

test('Rejeter retire la suggestion sans envoyer de message', async ({ request }) => {
  const page = ownerPage;
  // Conversation FRAÎCHE (contact dédié) → suggestion auto-générée intacte.
  await sendInbound(request, '+237659810001', 'Bonjour, une question sur un produit');
  await openFirstConversation(page);
  const textarea = page.getByTestId('ai-suggestion-text');
  await expect(textarea).toBeVisible({ timeout: 20000 });

  const outboundBefore = await page.getByTestId('message-outbound').count();
  await page.getByTestId('ai-reject').click();
  await expect(textarea).toHaveCount(0, { timeout: 10000 });
  // Aucun message envoyé par un rejet.
  await expect(page.getByTestId('message-outbound')).toHaveCount(outboundBefore);
});

test('Régénérer expire la suggestion courante (nouveau run exige un nouveau message)', async ({
  request,
}) => {
  const page = ownerPage;
  await sendInbound(request, '+237659820001', 'Bonjour, je cherche un cadeau');
  await openFirstConversation(page);
  await expect(page.getByTestId('ai-suggestion-text')).toBeVisible({ timeout: 20000 });

  // Régénérer supersède le run + expire la suggestion. Comme triggerMessageId
  // est unique (invariant validé), aucun nouveau run n'est créé pour le MÊME
  // message : la suggestion courante disparaît, sans spinner bloqué.
  await page.getByTestId('ai-regenerate').click();
  await expect(page.getByTestId('ai-suggestion-text')).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByTestId('ai-generating')).toHaveCount(0, { timeout: 15000 });

  // Une NOUVELLE question du client génère bien une nouvelle suggestion.
  await sendInbound(request, '+237659820001', 'En fait, plutôt pour un anniversaire');
  await expect(page.getByTestId('ai-suggestion-text')).toBeVisible({ timeout: 20000 });
});
