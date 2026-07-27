import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@whauto/database';
import {
  InvalidRoleTransitionError,
  InvitationAlreadyUsedError,
  InvitationEmailMismatchError,
  InvitationExpiredError,
  InvitationNotFoundError,
  OrganizationArchivedError,
  UserAlreadyMemberError,
} from '@whauto/shared';

import { ROLE_PERMISSIONS } from '../../common/tenant/permissions';
import type { TenantContext } from '../../common/tenant/tenant-context.interface';
import type { PrismaService } from '../../prisma/prisma.service';
import type { EmailProvider } from '../email/email-provider.interface';
import { TokenService } from '../auth/token.service';
import { InvitationsService } from './invitations.service';
import type { OrganizationAuditService } from './organization-audit.service';

const OWNER_TENANT: TenantContext = {
  userId: 'owner-1',
  organizationId: 'org-1',
  membershipId: 'membership-owner',
  role: 'OWNER',
  permissions: ROLE_PERMISSIONS.OWNER,
};

const ADMIN_TENANT: TenantContext = { ...OWNER_TENANT, userId: 'admin-1', role: 'ADMIN' };

const FUTURE = new Date(Date.now() + 60_000);
const PAST = new Date(Date.now() - 60_000);

const BASE_INVITATION = {
  id: 'invitation-1',
  organizationId: 'org-1',
  email: 'fatou@boutique.cm',
  role: 'AGENT' as const,
  status: 'PENDING' as const,
  expiresAt: FUTURE,
  organization: { status: 'ACTIVE' as const },
};

const INVITATION_PUBLIC = {
  id: 'invitation-1',
  organizationId: 'org-1',
  email: 'fatou@boutique.cm',
  role: 'AGENT' as const,
  status: 'PENDING' as const,
  expiresAt: FUTURE,
  createdAt: new Date(),
};

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: 'organization_invitations_one_pending_per_org_email' },
  });
}

function buildMocks() {
  const prisma = {
    organizationInvitation: {
      create: jest.fn().mockResolvedValue({ id: 'invitation-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue(INVITATION_PUBLIC),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    membership: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'membership-new' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ email: 'fatou@boutique.cm' }),
    },
    organization: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Boutique' }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma),
  );

  const config: Record<string, unknown> = {
    NODE_ENV: 'development',
    AUTH_EXPOSE_TEST_TOKENS: true,
    APP_WEB_URL: 'http://localhost:3000',
    INVITATION_EXPIRES_IN_DAYS: 7,
  };
  const configService = {
    get: jest.fn((key: string, defaultValue?: unknown) => config[key] ?? defaultValue),
  } as unknown as ConfigService;

  const tokenService = new TokenService(
    new JwtService({ secret: 'unit-test-secret-at-least-32-characters-long' }),
  );
  const auditService = {
    record: jest.fn().mockResolvedValue({}),
    recordSafe: jest.fn().mockResolvedValue(undefined),
  };
  const emailProvider = { send: jest.fn().mockResolvedValue(undefined) };

  const service = new InvitationsService(
    prisma as unknown as PrismaService,
    tokenService,
    configService,
    auditService as unknown as OrganizationAuditService,
    emailProvider as unknown as EmailProvider,
  );
  return { service, prisma, auditService, emailProvider, tokenService };
}

describe('InvitationsService', () => {
  describe('createOrResend', () => {
    it('hiérarchie : un ADMIN ne peut pas inviter un ADMIN', async () => {
      const { service } = buildMocks();
      await expect(
        service.createOrResend(ADMIN_TENANT, { email: 'x@y.cm', role: 'ADMIN' }, {}),
      ).rejects.toThrow(InvalidRoleTransitionError);
    });

    it('membre déjà ACTIVE → UserAlreadyMemberError', async () => {
      const { service, prisma } = buildMocks();
      prisma.user.findUnique.mockResolvedValue({ id: 'user-x' });
      prisma.membership.findUnique.mockResolvedValue({ status: 'ACTIVE' });

      await expect(
        service.createOrResend(OWNER_TENANT, { email: 'fatou@boutique.cm', role: 'AGENT' }, {}),
      ).rejects.toThrow(UserAlreadyMemberError);
    });

    it('membre SUSPENDED → invitation refusée (jamais de réactivation automatique)', async () => {
      const { service, prisma } = buildMocks();
      prisma.user.findUnique.mockResolvedValue({ id: 'user-x' });
      prisma.membership.findUnique.mockResolvedValue({ status: 'SUSPENDED' });

      await expect(
        service.createOrResend(OWNER_TENANT, { email: 'fatou@boutique.cm', role: 'AGENT' }, {}),
      ).rejects.toThrow(UserAlreadyMemberError);
    });

    it('membre LEFT → réinvitation autorisée', async () => {
      const { service, prisma } = buildMocks();
      prisma.user.findUnique.mockResolvedValue({ id: 'user-x' });
      prisma.membership.findUnique.mockResolvedValue({ status: 'LEFT' });

      const result = await service.createOrResend(
        OWNER_TENANT,
        { email: 'fatou@boutique.cm', role: 'AGENT' },
        {},
      );
      expect(result.resent).toBe(false);
      expect(prisma.organizationInvitation.create).toHaveBeenCalled();
    });

    it('création : email normalisé, hash stocké (jamais le token brut), devLink exposé en dev', async () => {
      const { service, prisma, emailProvider } = buildMocks();

      const result = await service.createOrResend(
        OWNER_TENANT,
        { email: '  Fatou@Boutique.CM ', role: 'AGENT' },
        {},
      );

      const data = prisma.organizationInvitation.create.mock.calls[0][0].data;
      expect(data.email).toBe('fatou@boutique.cm');
      expect(data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.devLink).toContain('/invitations/accept?token=');
      expect(result.devLink).not.toContain(data.tokenHash);
      expect(emailProvider.send).toHaveBeenCalledTimes(1);
      expect(result.resent).toBe(false);
    });

    it('PENDING existante → renouvelée en place (même ligne, nouveau tokenHash/expiresAt), audit INVITATION_RESENT', async () => {
      const { service, prisma, auditService } = buildMocks();
      prisma.organizationInvitation.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.createOrResend(
        OWNER_TENANT,
        { email: 'fatou@boutique.cm', role: 'MANAGER' },
        {},
      );

      expect(result.resent).toBe(true);
      expect(prisma.organizationInvitation.create).not.toHaveBeenCalled();
      const renewal = prisma.organizationInvitation.updateMany.mock.calls[0][0];
      expect(renewal.where).toEqual({
        organizationId: 'org-1',
        email: 'fatou@boutique.cm',
        status: 'PENDING',
      });
      expect(renewal.data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(renewal.data.role).toBe('MANAGER');
      expect(auditService.recordSafe).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'INVITATION_RESENT' }),
      );
    });

    it('course perdue sur l’index partiel → bascule en renouvellement', async () => {
      const { service, prisma } = buildMocks();
      prisma.organizationInvitation.updateMany
        .mockResolvedValueOnce({ count: 0 }) // premier essai de renouvellement
        .mockResolvedValueOnce({ count: 1 }); // après P2002, l'invitation concurrente existe
      prisma.organizationInvitation.create.mockRejectedValue(uniqueViolation());

      const result = await service.createOrResend(
        OWNER_TENANT,
        { email: 'fatou@boutique.cm', role: 'AGENT' },
        {},
      );
      expect(result.resent).toBe(true);
    });
  });

  describe('accept', () => {
    it('token inconnu → InvitationNotFoundError', async () => {
      const { service, prisma } = buildMocks();
      prisma.organizationInvitation.findUnique.mockResolvedValue(null);
      await expect(service.accept('user-1', 'unknown', {})).rejects.toThrow(
        InvitationNotFoundError,
      );
    });

    it('déjà ACCEPTED → InvitationAlreadyUsedError ; CANCELLED → indistincte d’un token inconnu', async () => {
      const { service, prisma } = buildMocks();
      prisma.organizationInvitation.findUnique.mockResolvedValueOnce({
        ...BASE_INVITATION,
        status: 'ACCEPTED',
      });
      await expect(service.accept('user-1', 't', {})).rejects.toThrow(InvitationAlreadyUsedError);

      prisma.organizationInvitation.findUnique.mockResolvedValueOnce({
        ...BASE_INVITATION,
        status: 'CANCELLED',
      });
      await expect(service.accept('user-1', 't', {})).rejects.toThrow(InvitationNotFoundError);
    });

    it('PENDING mais expirée → marquée EXPIRED paresseusement + InvitationExpiredError', async () => {
      const { service, prisma } = buildMocks();
      prisma.organizationInvitation.findUnique.mockResolvedValue({
        ...BASE_INVITATION,
        expiresAt: PAST,
      });

      await expect(service.accept('user-1', 't', {})).rejects.toThrow(InvitationExpiredError);
      expect(prisma.organizationInvitation.updateMany).toHaveBeenCalledWith({
        where: { id: 'invitation-1', status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
    });

    it('organisation archivée → refus', async () => {
      const { service, prisma } = buildMocks();
      prisma.organizationInvitation.findUnique.mockResolvedValue({
        ...BASE_INVITATION,
        organization: { status: 'ARCHIVED' },
      });
      await expect(service.accept('user-1', 't', {})).rejects.toThrow(OrganizationArchivedError);
    });

    it('email du compte différent de l’email invité → InvitationEmailMismatchError', async () => {
      const { service, prisma } = buildMocks();
      prisma.organizationInvitation.findUnique.mockResolvedValue(BASE_INVITATION);
      prisma.user.findUniqueOrThrow.mockResolvedValue({ email: 'autre@compte.cm' });
      await expect(service.accept('user-1', 't', {})).rejects.toThrow(
        InvitationEmailMismatchError,
      );
    });

    it('déjà membre ACTIVE → UserAlreadyMemberError ; SUSPENDED → refus aussi', async () => {
      const { service, prisma } = buildMocks();
      prisma.organizationInvitation.findUnique.mockResolvedValue(BASE_INVITATION);

      prisma.membership.findUnique.mockResolvedValueOnce({ id: 'm', status: 'ACTIVE' });
      await expect(service.accept('user-1', 't', {})).rejects.toThrow(UserAlreadyMemberError);

      prisma.membership.findUnique.mockResolvedValueOnce({ id: 'm', status: 'SUSPENDED' });
      await expect(service.accept('user-1', 't', {})).rejects.toThrow(UserAlreadyMemberError);
    });

    it('succès : consommation conditionnelle + création Membership + audit INVITATION_ACCEPTED en transaction', async () => {
      const { service, prisma, auditService } = buildMocks();
      prisma.organizationInvitation.findUnique.mockResolvedValue(BASE_INVITATION);
      prisma.organizationInvitation.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.accept('user-1', 't', {});

      const consumption = prisma.organizationInvitation.updateMany.mock.calls[0][0];
      expect(consumption.where).toMatchObject({ id: 'invitation-1', status: 'PENDING' });
      expect(prisma.membership.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            organizationId: 'org-1',
            role: 'AGENT',
            status: 'ACTIVE',
          }),
        }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'INVITATION_ACCEPTED' }),
        prisma,
      );
      expect(result.membershipId).toBe('membership-new');
      expect(result.role).toBe('AGENT');
    });

    it('membre LEFT : réactivé (updateMany conditionnel sur LEFT) au lieu d’être recréé', async () => {
      const { service, prisma } = buildMocks();
      prisma.organizationInvitation.findUnique.mockResolvedValue(BASE_INVITATION);
      prisma.organizationInvitation.updateMany.mockResolvedValue({ count: 1 });
      prisma.membership.findUnique.mockResolvedValue({ id: 'membership-old', status: 'LEFT' });

      const result = await service.accept('user-1', 't', {});

      expect(prisma.membership.create).not.toHaveBeenCalled();
      expect(prisma.membership.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'membership-old', status: 'LEFT' },
          data: expect.objectContaining({ status: 'ACTIVE', role: 'AGENT' }),
        }),
      );
      expect(result.membershipId).toBe('membership-old');
    });

    it('deux acceptations concurrentes : le perdant (count=0) échoue sans créer de Membership', async () => {
      const { service, prisma } = buildMocks();
      prisma.organizationInvitation.findUnique.mockResolvedValue(BASE_INVITATION);
      prisma.organizationInvitation.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.accept('user-1', 't', {})).rejects.toThrow(InvitationAlreadyUsedError);
      expect(prisma.membership.create).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('scoppée au tenant : le filtre inclut organizationId', async () => {
      const { service, prisma } = buildMocks();
      prisma.organizationInvitation.updateMany.mockResolvedValue({ count: 1 });

      await service.cancel(OWNER_TENANT, 'invitation-1', {});

      expect(prisma.organizationInvitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'invitation-1', organizationId: 'org-1', status: 'PENDING' },
        }),
      );
    });

    it('invitation non PENDING → InvitationAlreadyUsedError ; inconnue → NotFound', async () => {
      const { service, prisma } = buildMocks();
      prisma.organizationInvitation.updateMany.mockResolvedValue({ count: 0 });

      prisma.organizationInvitation.findFirst.mockResolvedValueOnce({ id: 'invitation-1' });
      await expect(service.cancel(OWNER_TENANT, 'invitation-1', {})).rejects.toThrow(
        InvitationAlreadyUsedError,
      );

      prisma.organizationInvitation.findFirst.mockResolvedValueOnce(null);
      await expect(service.cancel(OWNER_TENANT, 'other-org-invitation', {})).rejects.toThrow(
        InvitationNotFoundError,
      );
    });
  });

  describe('decline', () => {
    it('email correspondant requis, passage à DECLINED conditionnel', async () => {
      const { service, prisma, auditService } = buildMocks();
      prisma.organizationInvitation.findUnique.mockResolvedValue(BASE_INVITATION);
      prisma.organizationInvitation.updateMany.mockResolvedValue({ count: 1 });

      await service.decline('user-1', 't', {});

      expect(prisma.organizationInvitation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'invitation-1', status: 'PENDING' },
          data: expect.objectContaining({ status: 'DECLINED' }),
        }),
      );
      expect(auditService.recordSafe).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'INVITATION_DECLINED' }),
      );
    });
  });

  describe('listMine', () => {
    it('ne retourne que les PENDING non expirées de l’email du compte', async () => {
      const { service, prisma } = buildMocks();
      prisma.user.findUnique.mockResolvedValue({ email: 'Fatou@Boutique.CM' });

      await service.listMine('user-1');

      expect(prisma.organizationInvitation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            email: 'fatou@boutique.cm',
            status: 'PENDING',
            expiresAt: { gt: expect.any(Date) },
          }),
        }),
      );
    });
  });
});
