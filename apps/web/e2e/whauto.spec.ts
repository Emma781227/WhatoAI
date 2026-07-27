import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/**
 * Parcours navigateur complets contre la vraie API. Données préfixées par run
 * (`pw-<runId>-…@e2e.whauto.test`) — purgées par le nettoyage SQL de la
 * vérification finale (aucun endpoint de suppression de compte n'existe).
 */
const RUN_ID = Date.now().toString(36);
const PASSWORD = 'playwright-pass-123';
const OWNER_EMAIL = `pw-${RUN_ID}-owner@e2e.whauto.test`;
const AGENT_EMAIL = `pw-${RUN_ID}-agent@e2e.whauto.test`;
const ORG_NAME = `PW Org ${RUN_ID}`;
const SECOND_ORG_NAME = `PW Org Bis ${RUN_ID}`;
const SHOP_NAME = `PW Boutique ${RUN_ID}`;

const API = 'http://localhost:4000/api';

test.describe.configure({ mode: 'serial' });

let ownerContext: BrowserContext;
let ownerPage: Page;

async function loginAs(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('textbox', { name: 'Mot de passe' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

/** Crée et vérifie un compte directement via l'API (setup rapide du 2e utilisateur). */
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

test.beforeAll(async ({ browser }) => {
  ownerContext = await browser.newContext();
  ownerPage = await ownerContext.newPage();
});

test.afterAll(async () => {
  await ownerContext.close();
});

test('une route protégée redirige vers /login', async ({ page }) => {
  await page.goto('/shops');
  await expect(page).toHaveURL(/\/login\?next=/);
});

test('inscription, vérification par devLink, connexion et onboarding complet', async () => {
  const page = ownerPage;

  // Inscription via l'UI.
  await page.goto('/register');
  await page.getByLabel('Prénom').fill('Aïcha');
  await page.getByLabel('Nom', { exact: true }).fill('Owner');
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await page.getByRole('textbox', { name: 'Mot de passe' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Créer un compte' }).click();

  // Vérification email via le devLink affiché (mode développement).
  await expect(page.getByText('Vérifiez votre boîte mail')).toBeVisible();
  await page.getByRole('link', { name: 'ouvrir le lien' }).click();
  await expect(page.getByText('Email vérifié')).toBeVisible();

  // Connexion.
  await page.getByRole('link', { name: 'Se connecter' }).click();
  await loginAs(page, OWNER_EMAIL);

  // Aucune organisation → onboarding, étape organisation.
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel(/Nom de l/).fill(ORG_NAME);
  await page.getByRole('button', { name: 'Créer l’organisation' }).click();

  // Étape première boutique (auto-principale).
  await expect(page.getByText('Votre première boutique')).toBeVisible();
  await page.getByLabel('Nom de la boutique').fill(SHOP_NAME);
  await page.getByRole('button', { name: 'Créer la boutique' }).click();

  // Arrivée dashboard : org active + boutique principale visibles.
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('button', { name: new RegExp(ORG_NAME) })).toBeVisible();
  // Le nom apparaît deux fois depuis le ShopSwitcher topbar : cibler la carte.
  await expect(page.getByRole('link', { name: SHOP_NAME })).toBeVisible();
});

test('cookie HttpOnly présent, aucun token en localStorage/sessionStorage', async () => {
  // Le cookie est scoppé Path=/api/auth : cookies(url) filtre par chemin.
  const cookies = await ownerContext.cookies('http://localhost:4000/api/auth');
  const refreshCookie = cookies.find((cookie) => cookie.name === 'whauto_refresh');
  expect(refreshCookie).toBeDefined();
  expect(refreshCookie!.httpOnly).toBe(true);
  expect(refreshCookie!.path).toBe('/api/auth');

  const storage = await ownerPage.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
    localKeys: Object.keys(localStorage),
  }));
  // Seule la préférence d'org active est tolérée — jamais de JWT (eyJ...) ni de refresh token.
  expect(storage.local).not.toContain('eyJ');
  expect(storage.session).not.toContain('eyJ');
  expect(storage.localKeys.filter((key) => key !== 'whauto:active-org')).toEqual([]);
});

test('la session survit à un rechargement complet du navigateur', async () => {
  await ownerPage.reload();
  await expect(ownerPage).toHaveURL(/\/dashboard/);
  await expect(ownerPage.getByRole('button', { name: new RegExp(ORG_NAME) })).toBeVisible();
});

test('déconnexion puis reconnexion', async () => {
  const page = ownerPage;
  await page.getByRole('button', { name: 'Menu utilisateur' }).click();
  await page.getByRole('menuitem', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/login/);

  // La route protégée reste inaccessible après logout.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);

  await loginAs(page, OWNER_EMAIL);
  await expect(page).toHaveURL(/\/dashboard/);
});

test('création d’une deuxième organisation et changement d’organisation active', async () => {
  const page = ownerPage;
  await page.goto('/organizations/new');
  await page.getByLabel(/Nom de l/).fill(SECOND_ORG_NAME);
  await page.getByRole('button', { name: 'Créer l’organisation' }).click();

  // La nouvelle organisation devient active.
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('button', { name: new RegExp(SECOND_ORG_NAME) })).toBeVisible();
  // Ses boutiques sont vides — aucune donnée de l'ancien tenant ne fuit.
  await page.goto('/shops');
  await expect(page.getByText('Aucune boutique')).toBeVisible();

  // Retour à la première organisation via le sélecteur.
  await page.getByRole('button', { name: new RegExp(SECOND_ORG_NAME) }).click();
  await page.getByRole('menuitem', { name: new RegExp(ORG_NAME) }).click();
  await expect(page.getByRole('button', { name: new RegExp(ORG_NAME) })).toBeVisible();
  await page.goto('/shops');
  // Le nom apparaît aussi dans le ShopSwitcher topbar : cibler la carte.
  await expect(page.getByRole('link', { name: SHOP_NAME })).toBeVisible();
});

test('invitation d’un AGENT, acceptation par le second utilisateur, permissions restreintes', async ({
  browser,
  request,
}) => {
  // Compte AGENT créé et vérifié via l'API (setup), connexion via l'UI.
  await registerVerifiedUser(request, AGENT_EMAIL, 'Agent');

  // L'OWNER envoie l'invitation depuis /members.
  const page = ownerPage;
  await page.goto('/members');
  await page.getByRole('button', { name: 'Inviter un membre' }).click();
  await page.getByLabel('Email').fill(AGENT_EMAIL);
  await page.getByRole('button', { name: 'Envoyer l’invitation' }).click();
  const devLinkHref = await page
    .getByRole('link', { name: 'ouvrir le lien' })
    .getAttribute('href');
  expect(devLinkHref).toContain('/invitations/accept?token=');
  await page.keyboard.press('Escape');

  // Le second utilisateur accepte dans son propre contexte navigateur.
  const agentContext = await browser.newContext();
  const agentPage = await agentContext.newPage();
  await agentPage.goto(devLinkHref!);
  await expect(agentPage).toHaveURL(/\/login\?next=/); // connexion requise, next préservé
  await agentPage.getByLabel('Email').fill(AGENT_EMAIL);
  await agentPage.getByRole('textbox', { name: 'Mot de passe' }).fill(PASSWORD);
  await agentPage.getByRole('button', { name: 'Se connecter' }).click();
  await expect(agentPage.getByText('Invitation à rejoindre une organisation')).toBeVisible();
  await agentPage.getByRole('button', { name: 'Accepter' }).click();
  await expect(agentPage).toHaveURL(/\/dashboard/);
  await expect(agentPage.getByRole('button', { name: new RegExp(ORG_NAME) })).toBeVisible();

  // Permissions AGENT : lecture des boutiques sans bouton de création…
  // (le nom apparaît aussi dans le ShopSwitcher topbar : cibler la carte).
  await agentPage.goto('/shops');
  await expect(agentPage.getByRole('link', { name: SHOP_NAME })).toBeVisible();
  await expect(agentPage.getByRole('link', { name: 'Nouvelle boutique' })).toHaveCount(0);
  // …détail sans actions d'administration…
  await agentPage.getByRole('link', { name: SHOP_NAME }).click();
  await expect(agentPage.getByRole('button', { name: 'Activer' })).toHaveCount(0);
  await expect(agentPage.getByRole('button', { name: 'Archiver' })).toHaveCount(0);
  // …et un 403 backend (members.read absent) affiché proprement, sans crash.
  await agentPage.goto('/members');
  await expect(
    agentPage.getByText('You do not have permission to perform this action.'),
  ).toBeVisible();

  await agentContext.close();
});

test('modification de la boutique, horaires, chevauchement refusé, archivage', async () => {
  const page = ownerPage;

  // Activation depuis le détail (cibler la carte, pas le ShopSwitcher topbar).
  await page.goto('/shops');
  await page.getByRole('link', { name: SHOP_NAME }).click();
  await page.getByRole('button', { name: 'Activer' }).click();
  await expect(page.getByText('Boutique activée')).toBeVisible();

  // Modification (PATCH) dans les paramètres (le lien de la sidebar porte le même nom).
  await page.getByRole('main').getByRole('link', { name: 'Paramètres' }).click();
  await page.getByLabel('Description').fill('Boutique de démonstration Playwright');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByText('Boutique mise à jour')).toBeVisible();

  // Horaires : lundi ouvert avec deux plages valides.
  await page.getByLabel('Lundi ouvert').check();
  await page.locator('#MONDAY-opens-0').fill('08:00');
  await page.locator('#MONDAY-closes-0').fill('12:00');
  await page.getByRole('button', { name: 'Ajouter une plage' }).first().click();
  await page.locator('#MONDAY-opens-1').fill('14:00');
  await page.locator('#MONDAY-closes-1').fill('18:00');
  await page.getByRole('button', { name: 'Enregistrer les horaires' }).click();
  await expect(page.getByText('Horaires enregistrés')).toBeVisible();

  // Remplacement avec chevauchement → refusé par la validation (aucun envoi).
  await page.locator('#MONDAY-opens-1').fill('11:00');
  await page.getByRole('button', { name: 'Enregistrer les horaires' }).click();
  await expect(page.getByText('Les plages horaires se chevauchent')).toBeVisible();

  // Correction puis remplacement réussi.
  await page.locator('#MONDAY-opens-1').fill('13:00');
  await page.getByRole('button', { name: 'Enregistrer les horaires' }).click();
  await expect(page.getByText('Horaires enregistrés').first()).toBeVisible();

  // Archivage avec dialogue de confirmation, puis blocage post-archivage.
  await page.getByRole('link', { name: 'Retour à la boutique' }).click();
  await page.getByRole('button', { name: 'Archiver' }).click();
  await page.getByRole('button', { name: 'Archiver définitivement' }).click();
  await expect(page.getByText('Boutique archivée')).toBeVisible();
  await expect(page.getByText(/consultation seule/)).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'Paramètres' })).toHaveCount(0);
});
