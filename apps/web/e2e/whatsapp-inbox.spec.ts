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
 * Inbox WhatsApp de bout en bout : vraie API, vrai worker BullMQ (lancé ici
 * en process enfant — il n'a pas de port HTTP pour webServer), build de
 * production du front. Données préfixées par run.
 */
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'playwright-pass-123';
const OWNER_EMAIL = `pw-wa-${RUN_ID}-owner@e2e.whauto.test`;
const AGENT_EMAIL = `pw-wa-${RUN_ID}-agent@e2e.whauto.test`;
const ORG_NAME = `PW WA Org ${RUN_ID}`;
const SHOP_NAME = `PW WA Shop ${RUN_ID}`;
const SHOP2_NAME = `PW WA Shop Bis ${RUN_ID}`;
const CUSTOMER_PHONE = '+237651234567';

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
  const verifyResponse = await request.post(`${API}/auth/verify-email`, { data: { token } });
  expect(verifyResponse.status()).toBe(200);
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

async function simulateInbound(
  request: APIRequestContext,
  input: { channelId: string; phone: string; text: string; displayName?: string },
) {
  const response = await request.post(`${API}/dev/whatsapp/mock/inbound`, { data: input });
  expect(response.status()).toBe(202);
}

test.beforeAll(async ({ browser, request }) => {
  test.skip(!existsSync(WORKER_DIST), 'Worker non buildé — pnpm --filter @whauto/whatsapp-worker build');

  // Worker réel, délais mock courts pour observer PENDING → … → READ à l'écran.
  worker = spawn(process.execPath, [WORKER_DIST], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'fatal',
      REDIS_URL: 'redis://localhost:6379/1',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://whauto:whauto@localhost:5433/whauto_dev',
      WHATSAPP_JOB_ATTEMPTS: '2',
      WHATSAPP_JOB_BACKOFF_MS: '300',
      WHATSAPP_MOCK_DELIVERY_DELAY_MS: '700',
      WHATSAPP_MOCK_READ_DELAY_MS: '700',
      WHATSAPP_RECOVERY_SWEEP_INTERVAL_MS: '2000',
      WHATSAPP_RECOVERY_STALENESS_MS: '1000',
    },
    stdio: 'ignore',
  });

  // Setup données via API : owner + agent, org, 2 shops.
  await registerVerifiedUser(request, OWNER_EMAIL, 'Owner');
  await registerVerifiedUser(request, AGENT_EMAIL, 'Agent');
  ownerToken = await apiLogin(request, OWNER_EMAIL);
  const auth = { Authorization: `Bearer ${ownerToken}` };

  const orgRes = await request.post(`${API}/organizations`, {
    headers: auth,
    data: { name: ORG_NAME },
  });
  expect(orgRes.status()).toBe(201);
  orgId = ((await orgRes.json()) as { organization: { id: string } }).organization.id;

  const inviteRes = await request.post(`${API}/organizations/${orgId}/invitations`, {
    headers: auth,
    data: { email: AGENT_EMAIL, role: 'AGENT' },
  });
  expect(inviteRes.status()).toBe(201);
  const inviteToken = new URL(((await inviteRes.json()) as { devLink: string }).devLink)
    .searchParams.get('token')!;
  const agentToken = await apiLogin(request, AGENT_EMAIL);
  const acceptRes = await request.post(`${API}/invitations/accept`, {
    headers: { Authorization: `Bearer ${agentToken}` },
    data: { token: inviteToken },
  });
  expect(acceptRes.status()).toBe(200);

  const shopRes = await request.post(`${API}/organizations/${orgId}/shops`, {
    headers: auth,
    data: { name: SHOP_NAME, countryCode: 'CM' },
  });
  expect(shopRes.status()).toBe(201);
  shopId = ((await shopRes.json()) as { id: string }).id;
  const shop2Res = await request.post(`${API}/organizations/${orgId}/shops`, {
    headers: auth,
    data: { name: SHOP2_NAME, countryCode: 'CM' },
  });
  expect(shop2Res.status()).toBe(201);

  ownerContext = await browser.newContext();
  ownerPage = await ownerContext.newPage();
});

test.afterAll(async () => {
  await ownerContext?.close();
  worker?.kill();
});

test('inbox vide : proposition de connexion du canal MOCK, puis connexion via l’UI', async () => {
  const page = ownerPage;
  await loginAs(page, OWNER_EMAIL);

  await page.getByRole('link', { name: 'Conversations' }).click();
  await expect(page).toHaveURL(/\/conversations/);

  // État vide : formulaire de connexion (permission whatsappChannels.manage).
  await expect(page.getByText('Connecter WhatsApp')).toBeVisible();
  await page.getByLabel('Numéro WhatsApp (format international)').fill('+237650009999');
  await page.getByRole('button', { name: 'Connecter le canal (simulation)' }).click();

  // Canal connecté : l'inbox (vide) remplace le formulaire.
  await expect(page.getByText('Aucune conversation')).toBeVisible();

  const channelRes = await page.request.get(
    `${API}/organizations/${orgId}/shops/${shopId}/whatsapp-channel`,
    { headers: { Authorization: `Bearer ${ownerToken}` } },
  );
  expect(channelRes.status()).toBe(200);
  channelId = ((await channelRes.json()) as { id: string }).id;
});

test('un message client entrant fait apparaître la conversation SANS rechargement', async ({
  request,
}) => {
  const page = ownerPage;
  await expect(page.getByText('Aucune conversation')).toBeVisible();

  await simulateInbound(request, {
    channelId,
    phone: CUSTOMER_PHONE,
    displayName: 'Client Pw',
    text: 'Bonjour, avez-vous des sneakers ?',
  });

  // Socket.IO : la ligne apparaît sans reload.
  const row = page.getByTestId('conversation-row').first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row).toContainText('Client Pw');
  await expect(row).toContainText('Bonjour, avez-vous des sneakers ?');
  await expect(row.getByTestId('unread-badge')).toHaveText('1');
});

test('ouverture du fil, réponse, progression PENDING → SENT → DELIVERED → READ', async () => {
  const page = ownerPage;
  await page.getByTestId('conversation-row').first().click();

  // Le message entrant est affiché ; l'ouverture marque la conversation lue.
  await expect(page.getByTestId('message-inbound')).toContainText('des sneakers');

  await page.getByTestId('composer-input').fill('Oui ! Plusieurs modèles disponibles.');
  await page.getByTestId('composer-send').click();

  const outbound = page.getByTestId('message-outbound').last();
  await expect(outbound).toContainText('Plusieurs modèles disponibles');
  // Optimistic UI : visible immédiatement, puis les statuts progressent en
  // temps réel jusqu'à READ (double coche bleue) — sans doublon.
  await expect(outbound).toHaveAttribute('data-message-status', 'READ', { timeout: 20000 });
  await expect(page.getByTestId('message-outbound')).toHaveCount(1);
});

test('note interne : visible dans le fil équipe, jamais comme message client', async () => {
  const page = ownerPage;
  await page.getByRole('button', { name: 'Écrire une note interne' }).click();
  await page.getByTestId('composer-input').fill('Client intéressé par la nouvelle collection');
  await page.getByTestId('composer-send').click();

  const note = page.getByTestId('internal-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Note interne');
  await expect(note).toContainText('nouvelle collection');
  // Repasser en mode réponse pour la suite.
  await page.getByRole('button', { name: 'Repasser en réponse client' }).click();
});

test('assignation à un membre et changement de statut', async () => {
  const page = ownerPage;

  await page.getByTestId('assign-menu').click();
  await page.getByRole('menuitem', { name: /Playwright Agent/ }).click();
  await expect(page.getByTestId('assign-menu')).toContainText('→ Playwright', { timeout: 10000 });

  await page.getByTestId('status-menu').click();
  await page.getByRole('menuitem', { name: 'Résolue' }).click();
  await expect(page.getByTestId('status-menu')).toContainText('Résolue', { timeout: 10000 });
});

test('bascule de Shop : aucune fuite de conversations entre boutiques', async () => {
  const page = ownerPage;
  await page.goto('/conversations');
  await expect(page.getByTestId('conversation-row').first()).toBeVisible();

  // Shop 2 : aucun canal → proposition de connexion, aucune conversation du shop 1.
  await page.getByRole('button', { name: new RegExp(SHOP_NAME) }).click();
  await page.getByRole('menuitem', { name: new RegExp(SHOP2_NAME) }).click();
  await expect(page.getByText('Connecter WhatsApp')).toBeVisible();
  await expect(page.getByTestId('conversation-row')).toHaveCount(0);

  // Retour shop 1 : les conversations réapparaissent.
  await page.getByRole('button', { name: new RegExp(SHOP2_NAME) }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${SHOP_NAME}`) }).click();
  await expect(page.getByTestId('conversation-row').first()).toBeVisible();
});

test('AGENT : répond et change le statut, mais ne voit ni assignation ni gestion des tags', async ({
  browser,
  request,
}) => {
  // Nouveau message pour rouvrir une conversation active.
  await simulateInbound(request, {
    channelId,
    phone: CUSTOMER_PHONE,
    text: 'Et en pointure 42 ?',
  });

  const agentContext = await browser.newContext();
  const agentPage = await agentContext.newPage();
  await loginAs(agentPage, AGENT_EMAIL);
  await agentPage.goto('/conversations');

  const row = agentPage.getByTestId('conversation-row').first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();

  // Peut répondre.
  await expect(agentPage.getByTestId('composer-input')).toBeEnabled();
  // Peut changer le statut.
  await expect(agentPage.getByTestId('status-menu')).toBeEnabled();
  // Ne peut PAS assigner (menu absent — permission manquante).
  await expect(agentPage.getByTestId('assign-menu')).toHaveCount(0);
  // Ne peut PAS gérer les tags (panneau contact sans champ d'ajout).
  await agentPage.getByRole('button', { name: 'Afficher la fiche contact' }).click();
  await expect(agentPage.getByTestId('contact-panel')).toBeVisible();
  await expect(agentPage.getByLabel('Nouveau tag')).toHaveCount(0);

  await agentContext.close();
});

test('temps réel multi-utilisateurs : l’owner voit arriver la réponse de l’agent', async ({
  browser,
}) => {
  const page = ownerPage;
  await page.goto('/conversations');
  await page.getByTestId('conversation-row').first().click();

  // L'agent répond depuis sa propre session.
  const agentContext = await browser.newContext();
  const agentPage = await agentContext.newPage();
  await loginAs(agentPage, AGENT_EMAIL);
  await agentPage.goto('/conversations');
  await agentPage.getByTestId('conversation-row').first().click();
  await agentPage.getByTestId('composer-input').fill('Réponse envoyée par l’agent');
  await agentPage.getByTestId('composer-send').click();

  // L'owner reçoit le message par Socket.IO, sans rechargement.
  await expect(page.getByTestId('message-outbound').last()).toContainText(
    'Réponse envoyée par l’agent',
    { timeout: 15000 },
  );

  await agentContext.close();
});

test('marquer lu : le badge non-lu disparaît après ouverture', async ({ request }) => {
  const page = ownerPage;
  await simulateInbound(request, {
    channelId,
    phone: CUSTOMER_PHONE,
    text: 'Je prends la paire noire',
  });
  await page.goto('/conversations');
  const row = page.getByTestId('conversation-row').first();
  await expect(row.getByTestId('unread-badge')).toBeVisible({ timeout: 15000 });

  await row.click();
  await expect(page.getByTestId('message-inbound').last()).toContainText('paire noire');
  await page.goto('/conversations');
  await expect(
    page.getByTestId('conversation-row').first().getByTestId('unread-badge'),
  ).toHaveCount(0);
});
