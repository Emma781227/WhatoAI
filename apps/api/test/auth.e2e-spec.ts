// Overrides d'environnement AVANT l'import d'AppModule : dotenv (ConfigModule)
// n'écrase jamais une variable déjà présente dans process.env.
// - Redis DB 1 dédiée aux tests (compteurs de rate limit isolés puis flushés)
// - limites hautes pour ne pas déclencher le throttling dans les flux nominaux,
//   sauf resend-verification (basse) pour tester le 429.
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.AUTH_EXPOSE_TEST_TOKENS = 'true';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REGISTER_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REFRESH_MAX = '1000';
process.env.AUTH_RATE_LIMIT_RESET_MAX = '1000';
process.env.AUTH_RATE_LIMIT_FORGOT_PASSWORD_MAX = '1000';
process.env.AUTH_RATE_LIMIT_RESEND_VERIFICATION_MAX = '2';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Redis } from 'ioredis';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const RUN_ID = Date.now().toString(36);
const EMAIL_PREFIX = `e2e-${RUN_ID}`;
const COOKIE_NAME = 'whauto_refresh';
const PASSWORD = 'initial-password-123';

function email(tag: string): string {
  return `${EMAIL_PREFIX}-${tag}@e2e.whauto.test`;
}

function refreshCookieOf(res: request.Response): string {
  const setCookies: string[] = res.headers['set-cookie'] ?? [];
  const cookie = setCookies.find((value) => value.startsWith(`${COOKIE_NAME}=`));
  if (!cookie) {
    throw new Error(`Cookie ${COOKIE_NAME} absent de la réponse`);
  }
  return cookie.split(';')[0];
}

function tokenFromDevLink(devLink: string): string {
  const url = new URL(devLink);
  const token = url.searchParams.get('token');
  if (!token) {
    throw new Error(`Token absent du devLink : ${devLink}`);
  }
  return token;
}

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;

  beforeAll(async () => {
    // Purge des compteurs de rate limit de la DB Redis de test.
    const redis = new Redis(process.env.REDIS_URL as string);
    await redis.flushdb();
    redis.disconnect();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Miroir de main.ts (pipes/prefix/cookies identiques à la prod locale).
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    await app.close();
  });

  async function registerAndVerify(tag: string): Promise<string> {
    const userEmail = email(tag);
    const registerRes = await request(server)
      .post('/api/auth/register')
      .send({ email: userEmail, password: PASSWORD, firstName: 'E2E', lastName: 'Test' })
      .expect(201);
    await request(server)
      .post('/api/auth/verify-email')
      .send({ token: tokenFromDevLink(registerRes.body.devLink) })
      .expect(200);
    return userEmail;
  }

  async function login(userEmail: string, password = PASSWORD) {
    const res = await request(server)
      .post('/api/auth/login')
      .send({ email: userEmail, password })
      .expect(200);
    return { accessToken: res.body.accessToken as string, cookie: refreshCookieOf(res), res };
  }

  describe('register + vérification email', () => {
    it('register → 201 générique avec devLink ; login possible en PENDING ; verify-email active le compte', async () => {
      const userEmail = email('register');

      const registerRes = await request(server)
        .post('/api/auth/register')
        .send({ email: userEmail, password: PASSWORD, firstName: 'E2E', lastName: 'Test' })
        .expect(201);
      expect(registerRes.body.message).toBeTruthy();
      expect(registerRes.body.devLink).toContain('/verify-email?token=');

      // Re-register du même email PENDING → réponse générique (pas de 409), nouveau lien.
      const reRegisterRes = await request(server)
        .post('/api/auth/register')
        .send({ email: userEmail, password: 'another-password-42', firstName: 'X', lastName: 'Y' })
        .expect(201);
      expect(reRegisterRes.body.devLink).toContain('/verify-email?token=');

      // Un compte PENDING peut se connecter et accéder à /me et resend-verification.
      const { accessToken } = await login(userEmail);
      const meRes = await request(server)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(meRes.body.status).toBe('PENDING_VERIFICATION');
      expect(meRes.body).not.toHaveProperty('passwordHash');

      const resendRes = await request(server)
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      // Vérification avec le dernier token émis.
      await request(server)
        .post('/api/auth/verify-email')
        .send({ token: tokenFromDevLink(resendRes.body.devLink) })
        .expect(200);

      // Token de vérification à usage unique.
      await request(server)
        .post('/api/auth/verify-email')
        .send({ token: tokenFromDevLink(resendRes.body.devLink) })
        .expect(400);

      // Email désormais actif → register renvoie 409 avec le code métier.
      const conflictRes = await request(server)
        .post('/api/auth/register')
        .send({ email: userEmail, password: PASSWORD, firstName: 'E2E', lastName: 'Test' })
        .expect(409);
      expect(conflictRes.body.code).toBe('EMAIL_ALREADY_USED');
    });

    it('rejette un payload invalide (email malformé) avec 400', async () => {
      await request(server)
        .post('/api/auth/register')
        .send({ email: 'not-an-email', password: PASSWORD, firstName: 'A', lastName: 'B' })
        .expect(400);
    });
  });

  describe('login', () => {
    it('email inconnu et mauvais mot de passe → 401 générique identique', async () => {
      const userEmail = await registerAndVerify('login-generic');

      const unknownRes = await request(server)
        .post('/api/auth/login')
        .send({ email: email('ghost'), password: PASSWORD })
        .expect(401);
      const wrongRes = await request(server)
        .post('/api/auth/login')
        .send({ email: userEmail, password: 'wrong-password-42' })
        .expect(401);
      expect(unknownRes.body).toEqual(wrongRes.body);
    });

    it('pose le refresh token en cookie HttpOnly limité à /api/auth', async () => {
      const userEmail = await registerAndVerify('login-cookie');
      const { res } = await login(userEmail);

      const setCookie: string[] = res.headers['set-cookie'];
      const cookie = setCookie.find((value) => value.startsWith(`${COOKIE_NAME}=`)) as string;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Path=/api/auth');
      expect(cookie).toContain('SameSite=Strict');
      // Le refresh token n'apparaît jamais dans le corps JSON.
      expect(JSON.stringify(res.body)).not.toContain(cookie.split('=')[1].split(';')[0]);
    });
  });

  describe('refresh (rotation + anti-réutilisation)', () => {
    it('rotation : nouveau cookie et nouvel access token ; l’ancien refresh rejoué → 401 et famille révoquée', async () => {
      const userEmail = await registerAndVerify('refresh');
      const first = await login(userEmail);

      const refreshRes = await request(server)
        .post('/api/auth/refresh')
        .set('Cookie', first.cookie)
        .expect(200);
      const secondCookie = refreshCookieOf(refreshRes);
      expect(secondCookie).not.toBe(first.cookie);
      expect(refreshRes.body.accessToken).toBeTruthy();

      // Rejouer l'ancien refresh token → détection de réutilisation.
      const reuseRes = await request(server)
        .post('/api/auth/refresh')
        .set('Cookie', first.cookie)
        .expect(401);
      expect(reuseRes.body.code).toBe('REFRESH_TOKEN_REUSE_DETECTED');

      // Toute la famille est révoquée, y compris le token le plus récent.
      await request(server).post('/api/auth/refresh').set('Cookie', secondCookie).expect(401);
    });

    it('deux refresh strictement concurrents : exactement un seul réussit', async () => {
      const userEmail = await registerAndVerify('refresh-race');
      const { cookie } = await login(userEmail);

      const [a, b] = await Promise.all([
        request(server).post('/api/auth/refresh').set('Cookie', cookie),
        request(server).post('/api/auth/refresh').set('Cookie', cookie),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);
    });

    it('refresh sans cookie → 401', async () => {
      await request(server).post('/api/auth/refresh').expect(401);
    });
  });

  describe('logout', () => {
    it('révoque la session et efface le cookie ; idempotent', async () => {
      const userEmail = await registerAndVerify('logout');
      const { cookie } = await login(userEmail);

      const logoutRes = await request(server)
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .expect(204);
      const cleared: string[] = logoutRes.headers['set-cookie'];
      expect(cleared.some((value) => value.startsWith(`${COOKIE_NAME}=;`))).toBe(true);

      // Le refresh token révoqué est inutilisable.
      await request(server).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
      // Logout sans cookie ni session : toujours 204.
      await request(server).post('/api/auth/logout').expect(204);
    });
  });

  describe('change-password', () => {
    it('mauvais mot de passe courant → 401 ; succès → sessions révoquées + nouvelle session immédiate', async () => {
      const userEmail = await registerAndVerify('change-password');
      const first = await login(userEmail);

      await request(server)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${first.accessToken}`)
        .send({ currentPassword: 'wrong-password-42', newPassword: 'brand-new-password-9' })
        .expect(401);

      const changeRes = await request(server)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${first.accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: 'brand-new-password-9' })
        .expect(200);
      expect(changeRes.body.accessToken).toBeTruthy();
      const newCookie = refreshCookieOf(changeRes);

      // L'ancien refresh token (session révoquée) est mort, le nouveau fonctionne.
      await request(server).post('/api/auth/refresh').set('Cookie', first.cookie).expect(401);
      await request(server).post('/api/auth/refresh').set('Cookie', newCookie).expect(200);

      // Ancien mot de passe refusé, nouveau accepté.
      await request(server)
        .post('/api/auth/login')
        .send({ email: userEmail, password: PASSWORD })
        .expect(401);
      await login(userEmail, 'brand-new-password-9');
    });
  });

  describe('forgot-password / reset-password', () => {
    it('réponse générique pour email inconnu, sans devLink', async () => {
      const res = await request(server)
        .post('/api/auth/forgot-password')
        .send({ email: email('unknown-forgot') })
        .expect(200);
      expect(res.body.message).toBeTruthy();
      expect(res.body.devLink).toBeUndefined();
    });

    it('reset complet : nouveau mot de passe, sessions révoquées, token à usage unique', async () => {
      const userEmail = await registerAndVerify('reset');
      const { cookie } = await login(userEmail);

      const forgotRes = await request(server)
        .post('/api/auth/forgot-password')
        .send({ email: userEmail })
        .expect(200);
      const resetToken = tokenFromDevLink(forgotRes.body.devLink);

      await request(server)
        .post('/api/auth/reset-password')
        .send({ token: resetToken, newPassword: 'after-reset-password-7' })
        .expect(200);

      // Sessions existantes révoquées par le reset.
      await request(server).post('/api/auth/refresh').set('Cookie', cookie).expect(401);
      // Ancien mot de passe mort, nouveau OK.
      await request(server)
        .post('/api/auth/login')
        .send({ email: userEmail, password: PASSWORD })
        .expect(401);
      await login(userEmail, 'after-reset-password-7');

      // Token de reset à usage unique.
      await request(server)
        .post('/api/auth/reset-password')
        .send({ token: resetToken, newPassword: 'yet-another-password-3' })
        .expect(400);
    });
  });

  describe('protection des routes', () => {
    it('me sans token, token invalide → 401', async () => {
      await request(server).get('/api/auth/me').expect(401);
      await request(server).get('/api/auth/me').set('Authorization', 'Bearer garbage').expect(401);
    });
  });

  describe('rate limiting (Redis)', () => {
    it('resend-verification limité à 2 requêtes par fenêtre → 3e appel en 429', async () => {
      // Les compteurs sont par IP : on purge ceux consommés par les tests précédents.
      const redis = new Redis(process.env.REDIS_URL as string);
      await redis.flushdb();
      redis.disconnect();

      const userEmail = email('throttle');
      const registerRes = await request(server)
        .post('/api/auth/register')
        .send({ email: userEmail, password: PASSWORD, firstName: 'E2E', lastName: 'Test' })
        .expect(201);
      expect(registerRes.body.devLink).toBeTruthy();
      const { accessToken } = await login(userEmail);

      await request(server)
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      await request(server)
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      await request(server)
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(429);
    });
  });
});
