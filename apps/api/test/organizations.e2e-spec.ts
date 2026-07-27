// Overrides d'environnement AVANT l'import d'AppModule (dotenv n'écrase pas
// les variables déjà présentes). Redis DB 1 dédiée aux tests, limites de rate
// limit hautes pour ne pas interférer avec les flux.
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.AUTH_EXPOSE_TEST_TOKENS = 'true';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.AUTH_RATE_LIMIT_LOGIN_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REGISTER_MAX = '1000';
process.env.AUTH_RATE_LIMIT_REFRESH_MAX = '1000';
process.env.AUTH_RATE_LIMIT_RESET_MAX = '1000';
process.env.AUTH_RATE_LIMIT_FORGOT_PASSWORD_MAX = '1000';
process.env.AUTH_RATE_LIMIT_RESEND_VERIFICATION_MAX = '1000';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { Redis } from 'ioredis';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const RUN_ID = Date.now().toString(36);
const EMAIL_PREFIX = `e2e-org-${RUN_ID}`;
const SLUG_PREFIX = `e2e-org-${RUN_ID}`;
const PASSWORD = 'e2e-password-123';

function email(tag: string): string {
  return `${EMAIL_PREFIX}-${tag}@e2e.whauto.test`;
}

function tokenFromDevLink(devLink: string): string {
  const token = new URL(devLink).searchParams.get('token');
  if (!token) {
    throw new Error(`Token absent du devLink : ${devLink}`);
  }
  return token;
}

describe('Organizations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: unknown;

  /** Crée un compte vérifié et retourne son access token. */
  async function verifiedUser(tag: string): Promise<{ email: string; accessToken: string }> {
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

  /** Crée un compte NON vérifié (PENDING_VERIFICATION) connecté. */
  async function pendingUser(tag: string): Promise<{ email: string; accessToken: string }> {
    const userEmail = email(tag);
    await request(server)
      .post('/api/auth/register')
      .send({ email: userEmail, password: PASSWORD, firstName: 'E2E', lastName: tag })
      .expect(201);
    const loginRes = await request(server)
      .post('/api/auth/login')
      .send({ email: userEmail, password: PASSWORD })
      .expect(200);
    return { email: userEmail, accessToken: loginRes.body.accessToken };
  }

  async function createOrganization(
    accessToken: string,
    name: string,
    slug: string,
  ): Promise<{ organizationId: string; membershipId: string }> {
    const res = await request(server)
      .post('/api/organizations')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name, slug })
      .expect(201);
    expect(res.body.role).toBe('OWNER');
    return { organizationId: res.body.organization.id, membershipId: res.body.membershipId };
  }

  /** Invite `invitee` dans l'org et accepte l'invitation ; retourne membershipId. */
  async function inviteAndAccept(
    inviterToken: string,
    organizationId: string,
    invitee: { email: string; accessToken: string },
    role: 'ADMIN' | 'MANAGER' | 'AGENT',
  ): Promise<string> {
    const inviteRes = await request(server)
      .post(`/api/organizations/${organizationId}/invitations`)
      .set('Authorization', `Bearer ${inviterToken}`)
      .send({ email: invitee.email, role })
      .expect(201);
    const acceptRes = await request(server)
      .post('/api/invitations/accept')
      .set('Authorization', `Bearer ${invitee.accessToken}`)
      .send({ token: tokenFromDevLink(inviteRes.body.devLink) })
      .expect(200);
    return acceptRes.body.membershipId;
  }

  beforeAll(async () => {
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
    await app.init();
    // Listener persistant : supertest sur un serveur non démarré rouvre un
    // socket éphémère à chaque requête, source d'ECONNREFUSED transitoires
    // sous Windows quand la suite enchaîne beaucoup de requêtes.
    await app.listen(0);
    prisma = app.get(PrismaService);
    server = app.getHttpServer();
  });

  afterAll(async () => {
    // Les cascades Prisma suppriment memberships/invitations/audit avec les orgs.
    await prisma.organization.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    await app.close();
  });

  describe('création d’organisation', () => {
    it('refusée sans authentification (401)', async () => {
      await request(server).post('/api/organizations').send({ name: 'Sans auth' }).expect(401);
    });

    it('refusée pour un email non vérifié (403 EMAIL_NOT_VERIFIED)', async () => {
      const pending = await pendingUser('pending-creator');
      const res = await request(server)
        .post('/api/organizations')
        .set('Authorization', `Bearer ${pending.accessToken}`)
        .send({ name: 'Interdite' })
        .expect(403);
      expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('utilisateur vérifié : org créée avec Membership OWNER, défauts Cameroun, slug généré', async () => {
      const user = await verifiedUser('creator');
      const res = await request(server)
        .post('/api/organizations')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ name: `Boutique Créée ${RUN_ID}` })
        .expect(201);

      expect(res.body.role).toBe('OWNER');
      expect(res.body.membershipId).toBeTruthy();
      expect(res.body.organization.timezone).toBe('Africa/Douala');
      expect(res.body.organization.defaultCurrency).toBe('XAF');
      expect(res.body.organization.defaultLocale).toBe('fr');
      expect(res.body.organization.slug).toBe(`boutique-creee-${RUN_ID}`);

      const membership = await prisma.membership.findUnique({
        where: { id: res.body.membershipId },
        select: { role: true, status: true, organizationId: true },
      });
      expect(membership).toEqual({
        role: 'OWNER',
        status: 'ACTIVE',
        organizationId: res.body.organization.id,
      });

      await prisma.organization.delete({ where: { id: res.body.organization.id } });
    });

    it('slug déjà pris → 409', async () => {
      const user = await verifiedUser('slug-taken');
      await createOrganization(user.accessToken, 'Slug A', `${SLUG_PREFIX}-taken`);
      const res = await request(server)
        .post('/api/organizations')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ name: 'Slug B', slug: `${SLUG_PREFIX}-taken` })
        .expect(409);
      expect(res.body.code).toBe('ORGANIZATION_SLUG_ALREADY_USED');
    });
  });

  describe('isolation multi-tenant', () => {
    it('chaque utilisateur ne liste que ses organisations ; un externe reçoit 404 sur une org étrangère', async () => {
      const alice = await verifiedUser('alice');
      const bob = await verifiedUser('bob');
      const orgA = await createOrganization(alice.accessToken, 'Org Alice', `${SLUG_PREFIX}-alice`);
      const orgB = await createOrganization(bob.accessToken, 'Org Bob', `${SLUG_PREFIX}-bob`);

      const aliceList = await request(server)
        .get('/api/organizations')
        .set('Authorization', `Bearer ${alice.accessToken}`)
        .expect(200);
      const aliceOrgIds = aliceList.body.map(
        (item: { organization: { id: string } }) => item.organization.id,
      );
      expect(aliceOrgIds).toContain(orgA.organizationId);
      expect(aliceOrgIds).not.toContain(orgB.organizationId);

      // Lecture, modification, membres : 404 partout pour un non-membre (anti-énumération).
      for (const call of [
        request(server).get(`/api/organizations/${orgB.organizationId}`),
        request(server).patch(`/api/organizations/${orgB.organizationId}`).send({ name: 'Piratée' }),
        request(server).get(`/api/organizations/${orgB.organizationId}/members`),
      ]) {
        const res = await call.set('Authorization', `Bearer ${alice.accessToken}`);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ORGANIZATION_NOT_FOUND');
      }
    });

    it('spoofing X-Organization-Id : le Membership est vérifié en base, pas le header', async () => {
      const alice = await verifiedUser('spoof-victim');
      const mallory = await verifiedUser('spoof-attacker');
      const orgA = await createOrganization(alice.accessToken, 'Org Spoof', `${SLUG_PREFIX}-spoof`);
      await createOrganization(mallory.accessToken, 'Org Mallory', `${SLUG_PREFIX}-mallory`);

      // Header seul vers une org étrangère : 404.
      await request(server)
        .get(`/api/organizations/${orgA.organizationId}`)
        .set('Authorization', `Bearer ${mallory.accessToken}`)
        .set('X-Organization-Id', orgA.organizationId)
        .expect(404);
    });

    it('conflit path/header → 400 AMBIGUOUS_ORGANIZATION_SELECTOR', async () => {
      const user = await verifiedUser('ambiguous');
      const org = await createOrganization(user.accessToken, 'Org Ambiguë', `${SLUG_PREFIX}-ambigue`);
      const res = await request(server)
        .get(`/api/organizations/${org.organizationId}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .set('X-Organization-Id', 'une-autre-org')
        .expect(400);
      expect(res.body.code).toBe('AMBIGUOUS_ORGANIZATION_SELECTOR');
    });
  });

  describe('RBAC : modification et permissions', () => {
    it('OWNER modifie l’organisation ; AGENT reçoit 403 INSUFFICIENT_PERMISSION', async () => {
      const owner = await verifiedUser('rbac-owner');
      const agent = await verifiedUser('rbac-agent');
      const org = await createOrganization(owner.accessToken, 'Org RBAC', `${SLUG_PREFIX}-rbac`);
      await inviteAndAccept(owner.accessToken, org.organizationId, agent, 'AGENT');

      await request(server)
        .patch(`/api/organizations/${org.organizationId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ name: 'Org RBAC renommée' })
        .expect(200);

      const forbidden = await request(server)
        .patch(`/api/organizations/${org.organizationId}`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .send({ name: 'Tentative agent' })
        .expect(403);
      expect(forbidden.body.code).toBe('INSUFFICIENT_PERMISSION');

      // L'AGENT lit le détail (organization.read) avec ses permissions effectives.
      const detail = await request(server)
        .get(`/api/organizations/${org.organizationId}`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(200);
      expect(detail.body.role).toBe('AGENT');
      // Matrice AGENT étendue par les modules WhatsApp (2026-07-17), Catalogue
      // (2026-07-18), Panier (2026-07-18) puis Orders (2026-07-20) : parcours
      // commercial complet, sans annulation (orders.cancel = MANAGER+).
      expect(detail.body.permissions).toEqual([
        'organization.read',
        'shops.read',
        'whatsappChannels.read',
        'contacts.read',
        'conversations.read',
        'conversations.reply',
        'conversations.updateStatus',
        'conversations.addNote',
        'categories.read',
        'products.read',
        'inventory.read',
        'carts.read',
        'carts.create',
        'carts.update',
        'carts.abandon',
        'checkout.read',
        'checkout.update',
        'checkout.confirm',
        'orders.read',
        'orders.create',
        'orders.updateStatus',
        'orders.addNote',
        'orders.viewHistory',
      ]);
      expect(detail.body.memberCount).toBe(2);

      // AGENT sans members.read (validé) ni members.invite.
      await request(server)
        .get(`/api/organizations/${org.organizationId}/members`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(403);
      await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .send({ email: email('nobody'), role: 'AGENT' })
        .expect(403);
    });
  });

  describe('invitations', () => {
    it('flux complet : OWNER invite un AGENT, le bon email accepte, le Membership est créé', async () => {
      const owner = await verifiedUser('inv-owner');
      const invitee = await verifiedUser('inv-invitee');
      const org = await createOrganization(owner.accessToken, 'Org Inv', `${SLUG_PREFIX}-inv`);

      const inviteRes = await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: invitee.email, role: 'AGENT' })
        .expect(201);
      expect(inviteRes.body.resent).toBe(false);
      expect(JSON.stringify(inviteRes.body)).not.toContain('tokenHash');
      const token = tokenFromDevLink(inviteRes.body.devLink);

      // Visible dans /invitations/mine du destinataire.
      const mine = await request(server)
        .get('/api/invitations/mine')
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .expect(200);
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0].organization.id).toBe(org.organizationId);

      const acceptRes = await request(server)
        .post('/api/invitations/accept')
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .send({ token })
        .expect(200);
      expect(acceptRes.body.role).toBe('AGENT');

      // Token à usage unique : la réutilisation échoue.
      await request(server)
        .post('/api/invitations/accept')
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .send({ token })
        .expect(400);
    });

    it('le mauvais email ne peut pas accepter (403 INVITATION_EMAIL_MISMATCH)', async () => {
      const owner = await verifiedUser('mismatch-owner');
      const wrongUser = await verifiedUser('mismatch-wrong');
      const org = await createOrganization(owner.accessToken, 'Org Mism', `${SLUG_PREFIX}-mism`);

      const inviteRes = await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: email('mismatch-intended'), role: 'AGENT' })
        .expect(201);

      const res = await request(server)
        .post('/api/invitations/accept')
        .set('Authorization', `Bearer ${wrongUser.accessToken}`)
        .send({ token: tokenFromDevLink(inviteRes.body.devLink) })
        .expect(403);
      expect(res.body.code).toBe('INVITATION_EMAIL_MISMATCH');
    });

    it('invitation expirée refusée (expiration fonctionnelle même en status PENDING)', async () => {
      const owner = await verifiedUser('exp-owner');
      const invitee = await verifiedUser('exp-invitee');
      const org = await createOrganization(owner.accessToken, 'Org Exp', `${SLUG_PREFIX}-exp`);

      const inviteRes = await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: invitee.email, role: 'AGENT' })
        .expect(201);

      // Expiration forcée en base, status laissé PENDING.
      await prisma.organizationInvitation.update({
        where: { id: inviteRes.body.invitation.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await request(server)
        .post('/api/invitations/accept')
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .send({ token: tokenFromDevLink(inviteRes.body.devLink) })
        .expect(400);
      expect(res.body.code).toBe('INVITATION_EXPIRED');

      // Transition paresseuse constatée en base.
      const stored = await prisma.organizationInvitation.findUnique({
        where: { id: inviteRes.body.invitation.id },
        select: { status: true },
      });
      expect(stored?.status).toBe('EXPIRED');
    });

    it('renvoi : même ligne conservée, ancien token invalidé, nouveau token à usage unique', async () => {
      const owner = await verifiedUser('resend-owner');
      const invitee = await verifiedUser('resend-invitee');
      const org = await createOrganization(owner.accessToken, 'Org Resend', `${SLUG_PREFIX}-resend`);

      const first = await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: invitee.email, role: 'AGENT' })
        .expect(201);
      const firstToken = tokenFromDevLink(first.body.devLink);

      const second = await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: invitee.email, role: 'MANAGER' })
        .expect(201);
      expect(second.body.resent).toBe(true);
      // Même ligne conservée.
      expect(second.body.invitation.id).toBe(first.body.invitation.id);
      const secondToken = tokenFromDevLink(second.body.devLink);
      expect(secondToken).not.toBe(firstToken);

      // Une seule invitation en base pour ce couple (org, email).
      const count = await prisma.organizationInvitation.count({
        where: { organizationId: org.organizationId, email: invitee.email },
      });
      expect(count).toBe(1);

      // L'ancien token est mort.
      await request(server)
        .post('/api/invitations/accept')
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .send({ token: firstToken })
        .expect(404);

      // Le nouveau fonctionne, une seule fois, avec le rôle renouvelé.
      const acceptRes = await request(server)
        .post('/api/invitations/accept')
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .send({ token: secondToken })
        .expect(200);
      expect(acceptRes.body.role).toBe('MANAGER');
      await request(server)
        .post('/api/invitations/accept')
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .send({ token: secondToken })
        .expect(400);
    });

    it('invitation OWNER impossible : rejetée par la validation DTO et par l’enum PostgreSQL', async () => {
      const owner = await verifiedUser('owner-inv-owner');
      const org = await createOrganization(owner.accessToken, 'Org NoOwner', `${SLUG_PREFIX}-noowner`);

      // Validation DTO : 400.
      await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: email('nobody2'), role: 'OWNER' })
        .expect(400);

      // Niveau base : l'enum InvitationRole ne contient pas OWNER.
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO organization_invitations ("id","organizationId","email","role","tokenHash","expiresAt","updatedAt")
           VALUES ('raw-test-owner-inv','${org.organizationId}','x@y.z','OWNER','deadbeef',NOW(),NOW())`,
        ),
      ).rejects.toThrow(/invalid input value for enum/i);
    });

    it('ADMIN ne peut pas inviter un ADMIN (hiérarchie stricte) mais peut inviter un AGENT', async () => {
      const owner = await verifiedUser('hier-owner');
      const admin = await verifiedUser('hier-admin');
      const org = await createOrganization(owner.accessToken, 'Org Hier', `${SLUG_PREFIX}-hier`);
      await inviteAndAccept(owner.accessToken, org.organizationId, admin, 'ADMIN');

      const forbidden = await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ email: email('hier-x'), role: 'ADMIN' })
        .expect(403);
      expect(forbidden.body.code).toBe('INVALID_ROLE_TRANSITION');

      await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ email: email('hier-y'), role: 'AGENT' })
        .expect(201);
    });

    it('annulation : OWNER annule, le token devient inutilisable', async () => {
      const owner = await verifiedUser('cancel-owner');
      const invitee = await verifiedUser('cancel-invitee');
      const org = await createOrganization(owner.accessToken, 'Org Cancel', `${SLUG_PREFIX}-cancel`);

      const inviteRes = await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: invitee.email, role: 'AGENT' })
        .expect(201);

      await request(server)
        .post(
          `/api/organizations/${org.organizationId}/invitations/${inviteRes.body.invitation.id}/cancel`,
        )
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(204);

      await request(server)
        .post('/api/invitations/accept')
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .send({ token: tokenFromDevLink(inviteRes.body.devLink) })
        .expect(404);
    });
  });

  describe('membres', () => {
    it('liste paginée pour OWNER, sans champ sensible ; changement de rôle audité ; retrait → LEFT', async () => {
      const owner = await verifiedUser('mem-owner');
      const agent = await verifiedUser('mem-agent');
      const org = await createOrganization(owner.accessToken, 'Org Mem', `${SLUG_PREFIX}-mem`);
      const agentMembershipId = await inviteAndAccept(
        owner.accessToken,
        org.organizationId,
        agent,
        'AGENT',
      );

      const list = await request(server)
        .get(`/api/organizations/${org.organizationId}/members?page=1&limit=20`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(list.body.total).toBe(2);
      expect(list.body.page).toBe(1);
      expect(list.body.limit).toBe(20);
      const raw = JSON.stringify(list.body);
      expect(raw).not.toContain('passwordHash');
      expect(raw).not.toContain('tokenHash');

      // Changement de rôle AGENT → MANAGER par l'OWNER.
      const updated = await request(server)
        .patch(`/api/organizations/${org.organizationId}/members/${agentMembershipId}/role`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ role: 'MANAGER' })
        .expect(200);
      expect(updated.body.role).toBe('MANAGER');

      const audit = await prisma.organizationAuditEvent.findFirst({
        where: { organizationId: org.organizationId, eventType: 'MEMBER_ROLE_CHANGED' },
        select: { metadata: true },
      });
      expect(audit?.metadata).toEqual({ from: 'AGENT', to: 'MANAGER' });

      // Retrait : Membership conservé en LEFT, plus listé, accès coupé.
      await request(server)
        .delete(`/api/organizations/${org.organizationId}/members/${agentMembershipId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(204);

      const stored = await prisma.membership.findUnique({
        where: { id: agentMembershipId },
        select: { status: true },
      });
      expect(stored?.status).toBe('LEFT');

      await request(server)
        .get(`/api/organizations/${org.organizationId}`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(404);
    });

    it('OWNER intouchable : ni changement de rôle ni retrait, même par lui-même', async () => {
      const owner = await verifiedUser('prot-owner');
      const admin = await verifiedUser('prot-admin');
      const org = await createOrganization(owner.accessToken, 'Org Prot', `${SLUG_PREFIX}-prot`);
      await inviteAndAccept(owner.accessToken, org.organizationId, admin, 'ADMIN');

      const removeByAdmin = await request(server)
        .delete(`/api/organizations/${org.organizationId}/members/${org.membershipId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .expect(403);
      expect(removeByAdmin.body.code).toBe('CANNOT_REMOVE_OWNER');

      await request(server)
        .patch(`/api/organizations/${org.organizationId}/members/${org.membershipId}/role`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ role: 'AGENT' })
        .expect(403);
    });

    it('ADMIN respecte ses limites : gère un AGENT mais pas un autre ADMIN', async () => {
      const owner = await verifiedUser('lim-owner');
      const admin1 = await verifiedUser('lim-admin1');
      const admin2 = await verifiedUser('lim-admin2');
      const agent = await verifiedUser('lim-agent');
      const org = await createOrganization(owner.accessToken, 'Org Lim', `${SLUG_PREFIX}-lim`);
      await inviteAndAccept(owner.accessToken, org.organizationId, admin1, 'ADMIN');
      const admin2MembershipId = await inviteAndAccept(
        owner.accessToken,
        org.organizationId,
        admin2,
        'ADMIN',
      );
      const agentMembershipId = await inviteAndAccept(
        owner.accessToken,
        org.organizationId,
        agent,
        'AGENT',
      );

      // ADMIN gère un AGENT.
      await request(server)
        .patch(`/api/organizations/${org.organizationId}/members/${agentMembershipId}/role`)
        .set('Authorization', `Bearer ${admin1.accessToken}`)
        .send({ role: 'MANAGER' })
        .expect(200);

      // ADMIN ne touche pas un autre ADMIN.
      await request(server)
        .patch(`/api/organizations/${org.organizationId}/members/${admin2MembershipId}/role`)
        .set('Authorization', `Bearer ${admin1.accessToken}`)
        .send({ role: 'AGENT' })
        .expect(403);
      await request(server)
        .delete(`/api/organizations/${org.organizationId}/members/${admin2MembershipId}`)
        .set('Authorization', `Bearer ${admin1.accessToken}`)
        .expect(403);
    });

    it('un membre peut quitter ; l’OWNER ne peut pas', async () => {
      const owner = await verifiedUser('leave-owner');
      const agent = await verifiedUser('leave-agent');
      const org = await createOrganization(owner.accessToken, 'Org Leave', `${SLUG_PREFIX}-leave`);
      await inviteAndAccept(owner.accessToken, org.organizationId, agent, 'AGENT');

      const ownerLeave = await request(server)
        .post(`/api/organizations/${org.organizationId}/leave`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(403);
      expect(ownerLeave.body.code).toBe('CANNOT_LEAVE_AS_OWNER');

      await request(server)
        .post(`/api/organizations/${org.organizationId}/leave`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(204);
      await request(server)
        .get(`/api/organizations/${org.organizationId}`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(404);
    });

    it('membership SUSPENDED : accès coupé et jamais réactivé par une invitation', async () => {
      const owner = await verifiedUser('susp-owner');
      const agent = await verifiedUser('susp-agent');
      const org = await createOrganization(owner.accessToken, 'Org SuspM', `${SLUG_PREFIX}-suspm`);
      const membershipId = await inviteAndAccept(
        owner.accessToken,
        org.organizationId,
        agent,
        'AGENT',
      );

      await prisma.membership.update({
        where: { id: membershipId },
        data: { status: 'SUSPENDED' },
      });

      // Accès coupé.
      await request(server)
        .get(`/api/organizations/${org.organizationId}`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(404);

      // Réinvitation refusée : SUSPENDED n'est jamais réactivé automatiquement.
      const res = await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: agent.email, role: 'AGENT' })
        .expect(409);
      expect(res.body.code).toBe('USER_ALREADY_MEMBER');
    });

    it('réinvitation après départ : le Membership LEFT est réactivé (même ligne, nouveau rôle)', async () => {
      const owner = await verifiedUser('rejoin-owner');
      const agent = await verifiedUser('rejoin-agent');
      const org = await createOrganization(owner.accessToken, 'Org Rejoin', `${SLUG_PREFIX}-rejoin`);
      const membershipId = await inviteAndAccept(
        owner.accessToken,
        org.organizationId,
        agent,
        'AGENT',
      );

      await request(server)
        .post(`/api/organizations/${org.organizationId}/leave`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(204);

      const newMembershipId = await inviteAndAccept(
        owner.accessToken,
        org.organizationId,
        agent,
        'MANAGER',
      );
      // Même ligne réactivée, rôle mis à jour.
      expect(newMembershipId).toBe(membershipId);
      const stored = await prisma.membership.findUnique({
        where: { id: membershipId },
        select: { status: true, role: true },
      });
      expect(stored).toEqual({ status: 'ACTIVE', role: 'MANAGER' });
    });
  });

  describe('OWNER unique (index partiel PostgreSQL)', () => {
    it('un deuxième OWNER ACTIVE est impossible, même par écriture directe concurrente', async () => {
      const owner = await verifiedUser('uniq-owner');
      const other = await verifiedUser('uniq-other');
      const org = await createOrganization(owner.accessToken, 'Org Uniq', `${SLUG_PREFIX}-uniq`);
      const otherUser = await prisma.user.findUniqueOrThrow({
        where: { email: other.email },
        select: { id: true },
      });

      // Écriture directe (contourne toute la couche applicative) : l'index partiel refuse.
      await expect(
        prisma.membership.create({
          data: {
            userId: otherUser.id,
            organizationId: org.organizationId,
            role: 'OWNER',
            status: 'ACTIVE',
          },
        }),
      ).rejects.toThrow(/unique constraint/i);

      // Accès concurrent : deux tentatives simultanées, zéro succès (l'OWNER existe déjà).
      const third = await verifiedUser('uniq-third');
      const thirdUser = await prisma.user.findUniqueOrThrow({
        where: { email: third.email },
        select: { id: true },
      });
      const attempts = await Promise.allSettled([
        prisma.membership.create({
          data: {
            userId: otherUser.id,
            organizationId: org.organizationId,
            role: 'OWNER',
            status: 'ACTIVE',
          },
        }),
        prisma.membership.create({
          data: {
            userId: thirdUser.id,
            organizationId: org.organizationId,
            role: 'OWNER',
            status: 'ACTIVE',
          },
        }),
      ]);
      expect(attempts.every((attempt) => attempt.status === 'rejected')).toBe(true);
    });
  });

  describe('archivage et statuts d’organisation', () => {
    it('AGENT ne peut pas archiver ; OWNER archive ; tout est bloqué sauf lecture ; double archivage refusé', async () => {
      const owner = await verifiedUser('arch-owner');
      const agent = await verifiedUser('arch-agent');
      const org = await createOrganization(owner.accessToken, 'Org Arch', `${SLUG_PREFIX}-arch`);
      await inviteAndAccept(owner.accessToken, org.organizationId, agent, 'AGENT');

      await request(server)
        .post(`/api/organizations/${org.organizationId}/archive`)
        .set('Authorization', `Bearer ${agent.accessToken}`)
        .expect(403);

      const archived = await request(server)
        .post(`/api/organizations/${org.organizationId}/archive`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(archived.body.status).toBe('ARCHIVED');

      // Lecture seule encore permise (@AllowArchived) et statut visible dans la liste.
      const detail = await request(server)
        .get(`/api/organizations/${org.organizationId}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(detail.body.status).toBe('ARCHIVED');
      const list = await request(server)
        .get('/api/organizations')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      const listed = list.body.find(
        (item: { organization: { id: string } }) => item.organization.id === org.organizationId,
      );
      expect(listed.organization.status).toBe('ARCHIVED');

      // Toute opération est bloquée, y compris un second archivage.
      for (const call of [
        request(server)
          .patch(`/api/organizations/${org.organizationId}`)
          .send({ name: 'Interdit' }),
        request(server).get(`/api/organizations/${org.organizationId}/members`),
        request(server)
          .post(`/api/organizations/${org.organizationId}/invitations`)
          .send({ email: email('arch-x'), role: 'AGENT' }),
        request(server).post(`/api/organizations/${org.organizationId}/archive`),
        request(server).post(`/api/organizations/${org.organizationId}/leave`),
      ]) {
        const res = await call.set('Authorization', `Bearer ${owner.accessToken}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ORGANIZATION_ARCHIVED');
      }
    });

    it('organisation SUSPENDED : tout accès métier bloqué, lecture comprise', async () => {
      const owner = await verifiedUser('susp-org-owner');
      const org = await createOrganization(owner.accessToken, 'Org Susp', `${SLUG_PREFIX}-susp`);

      await prisma.organization.update({
        where: { id: org.organizationId },
        data: { status: 'SUSPENDED' },
      });

      for (const call of [
        request(server).get(`/api/organizations/${org.organizationId}`),
        request(server)
          .patch(`/api/organizations/${org.organizationId}`)
          .send({ name: 'Interdit' }),
        request(server).get(`/api/organizations/${org.organizationId}/members`),
      ]) {
        const res = await call.set('Authorization', `Bearer ${owner.accessToken}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ORGANIZATION_SUSPENDED');
      }
    });

    it('invitation d’une org archivée inacceptable', async () => {
      const owner = await verifiedUser('archinv-owner');
      const invitee = await verifiedUser('archinv-invitee');
      const org = await createOrganization(owner.accessToken, 'Org ArchInv', `${SLUG_PREFIX}-archinv`);

      const inviteRes = await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: invitee.email, role: 'AGENT' })
        .expect(201);

      await request(server)
        .post(`/api/organizations/${org.organizationId}/archive`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      const res = await request(server)
        .post('/api/invitations/accept')
        .set('Authorization', `Bearer ${invitee.accessToken}`)
        .send({ token: tokenFromDevLink(inviteRes.body.devLink) })
        .expect(403);
      expect(res.body.code).toBe('ORGANIZATION_ARCHIVED');
    });
  });

  describe('concurrence', () => {
    it('deux acceptations simultanées de la même invitation : exactement une réussit', async () => {
      const owner = await verifiedUser('race-owner');
      const invitee = await verifiedUser('race-invitee');
      const org = await createOrganization(owner.accessToken, 'Org Race', `${SLUG_PREFIX}-race`);

      const inviteRes = await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: invitee.email, role: 'AGENT' })
        .expect(201);
      const token = tokenFromDevLink(inviteRes.body.devLink);

      const [a, b] = await Promise.all([
        request(server)
          .post('/api/invitations/accept')
          .set('Authorization', `Bearer ${invitee.accessToken}`)
          .send({ token }),
        request(server)
          .post('/api/invitations/accept')
          .set('Authorization', `Bearer ${invitee.accessToken}`)
          .send({ token }),
      ]);
      expect([a.status, b.status].filter((status) => status === 200)).toHaveLength(1);

      const memberships = await prisma.membership.count({
        where: { organizationId: org.organizationId },
      });
      expect(memberships).toBe(2); // OWNER + un seul AGENT
    });
  });

  describe('hygiène des réponses', () => {
    it('aucune réponse du module ne contient passwordHash ni tokenHash', async () => {
      const owner = await verifiedUser('hygiene-owner');
      const org = await createOrganization(owner.accessToken, 'Org Hyg', `${SLUG_PREFIX}-hyg`);

      const inviteRes = await request(server)
        .post(`/api/organizations/${org.organizationId}/invitations`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ email: email('hygiene-target'), role: 'AGENT' })
        .expect(201);

      const responses = await Promise.all([
        request(server).get('/api/organizations').set('Authorization', `Bearer ${owner.accessToken}`),
        request(server)
          .get(`/api/organizations/${org.organizationId}`)
          .set('Authorization', `Bearer ${owner.accessToken}`),
        request(server)
          .get(`/api/organizations/${org.organizationId}/members`)
          .set('Authorization', `Bearer ${owner.accessToken}`),
        request(server)
          .get(`/api/organizations/${org.organizationId}/invitations`)
          .set('Authorization', `Bearer ${owner.accessToken}`),
      ]);

      for (const res of [...responses, inviteRes]) {
        const raw = JSON.stringify(res.body);
        expect(raw).not.toContain('passwordHash');
        expect(raw).not.toContain('tokenHash');
        expect(raw).not.toContain('refreshTokenHash');
      }
    });
  });
});
