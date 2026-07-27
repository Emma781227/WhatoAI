import type { ConfigService } from '@nestjs/config';
import {
  EmailAlreadyUsedError,
  InvalidCredentialsError,
  InvalidVerificationTokenError,
  UserNotActiveError,
} from '@whauto/shared';

import type { PrismaService } from '../../prisma/prisma.service';
import type { EmailProvider } from '../email/email-provider.interface';
import { AuthService } from './auth.service';
import type { PasswordService } from './password.service';
import { SESSION_REVOCATION_REASON } from './session.service';
import type { SessionService } from './session.service';
import type { TokenService } from './token.service';

const FUTURE = new Date(Date.now() + 60_000);

const activeUser = {
  id: 'user-1',
  email: 'aicha@boutique.sn',
  firstName: 'Aïcha',
  lastName: 'Diallo',
  status: 'ACTIVE',
  emailVerifiedAt: new Date(),
  createdAt: new Date(),
};

function buildMocks(configOverrides: Record<string, unknown> = {}) {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({ id: 'user-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    emailVerificationToken: {
      findUnique: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    passwordResetToken: {
      findUnique: jest.fn(),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    authAuditEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  // Le mock de transaction réutilise les mêmes délégués (array et callback).
  prisma.$transaction.mockImplementation(async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma),
  );

  const passwordService = {
    validateStrength: jest.fn(),
    hash: jest.fn(async (password: string) => `hashed:${password}`),
    verify: jest.fn().mockResolvedValue(true),
    assertNotReused: jest.fn(),
  };

  let opaqueCounter = 0;
  const tokenService = {
    signAccessToken: jest.fn().mockResolvedValue('signed-access-token'),
    generateOpaqueToken: jest.fn(() => `opaque-${++opaqueCounter}`),
    hashOpaqueToken: jest.fn((token: string) => `hash:${token}`),
  };

  const sessionService = {
    createSession: jest.fn().mockResolvedValue({
      sessionId: 'session-new',
      refreshToken: 'new-refresh-token',
      expiresAt: FUTURE,
    }),
    rotate: jest.fn(),
    revokeAllForUser: jest.fn().mockResolvedValue(2),
    revokeFamily: jest.fn().mockResolvedValue(1),
    revokeByRefreshToken: jest.fn(),
  };

  const config: Record<string, unknown> = {
    NODE_ENV: 'development',
    AUTH_EXPOSE_TEST_TOKENS: true,
    APP_WEB_URL: 'http://localhost:3000',
    EMAIL_VERIFICATION_EXPIRES_IN_HOURS: 24,
    PASSWORD_RESET_EXPIRES_IN_MINUTES: 30,
    ...configOverrides,
  };
  const configService = {
    get: jest.fn((key: string, defaultValue?: unknown) => config[key] ?? defaultValue),
  };

  const emailProvider = { send: jest.fn().mockResolvedValue(undefined) };

  const service = new AuthService(
    prisma as unknown as PrismaService,
    passwordService as unknown as PasswordService,
    tokenService as unknown as TokenService,
    sessionService as unknown as SessionService,
    configService as unknown as ConfigService,
    emailProvider as unknown as EmailProvider,
  );

  return { service, prisma, passwordService, tokenService, sessionService, emailProvider };
}

describe('AuthService', () => {
  describe('register', () => {
    it('crée le compte, envoie un email de vérification et expose le lien en dev', async () => {
      const { service, prisma, emailProvider } = buildMocks();
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'user-1', email: 'aicha@boutique.sn' });

      const result = await service.register(
        { email: '  Aicha@Boutique.SN ', password: 'password-123', firstName: 'Aïcha', lastName: 'Diallo' },
        {},
      );

      // Email normalisé (trim + lowercase)
      expect(prisma.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'aicha@boutique.sn' } }),
      );
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      expect(prisma.user.create.mock.calls[0][0].data.passwordHash).toBe('hashed:password-123');
      expect(emailProvider.send).toHaveBeenCalledTimes(1);
      expect(result.devLink).toContain('/verify-email?token=');
    });

    it('email actif existant → EmailAlreadyUsedError (409), sans création', async () => {
      const { service, prisma } = buildMocks();
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', status: 'ACTIVE' });

      await expect(
        service.register(
          { email: 'aicha@boutique.sn', password: 'password-123', firstName: 'A', lastName: 'D' },
          {},
        ),
      ).rejects.toThrow(EmailAlreadyUsedError);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('compte PENDING existant → réponse générique + renvoi de vérification, sans recréation ni changement de mot de passe', async () => {
      const { service, prisma, emailProvider, passwordService } = buildMocks();
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', status: 'PENDING_VERIFICATION' });

      const result = await service.register(
        { email: 'aicha@boutique.sn', password: 'other-password', firstName: 'A', lastName: 'D' },
        {},
      );

      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(passwordService.hash).not.toHaveBeenCalled();
      expect(emailProvider.send).toHaveBeenCalledTimes(1);
      expect(result.message).toBeTruthy();
    });
  });

  describe('login', () => {
    it('retourne user public + tokens en cas de succès', async () => {
      const { service, prisma, sessionService } = buildMocks();
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, passwordHash: 'stored-hash' });

      const result = await service.login(
        { email: 'aicha@boutique.sn', password: 'password-123' },
        { ipAddress: '::1' },
      );

      expect(result.accessToken).toBe('signed-access-token');
      expect(result.refreshToken).toBe('new-refresh-token');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(sessionService.createSession).toHaveBeenCalledWith('user-1', { ipAddress: '::1' });
    });

    it('email inconnu et mot de passe faux produisent la même erreur générique', async () => {
      const { service, prisma, passwordService } = buildMocks();

      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.login({ email: 'ghost@nowhere.io', password: 'password-123' }, {}),
      ).rejects.toThrow(InvalidCredentialsError);

      prisma.user.findUnique.mockResolvedValueOnce({ ...activeUser, passwordHash: 'stored' });
      passwordService.verify.mockResolvedValueOnce(false);
      await expect(
        service.login({ email: 'aicha@boutique.sn', password: 'wrong' }, {}),
      ).rejects.toThrow(InvalidCredentialsError);
    });

    it('compte SUSPENDED → UserNotActiveError', async () => {
      const { service, prisma } = buildMocks();
      prisma.user.findUnique.mockResolvedValue({
        ...activeUser,
        status: 'SUSPENDED',
        passwordHash: 'stored',
      });

      await expect(
        service.login({ email: 'aicha@boutique.sn', password: 'password-123' }, {}),
      ).rejects.toThrow(UserNotActiveError);
    });

    it('un compte PENDING_VERIFICATION peut se connecter', async () => {
      const { service, prisma } = buildMocks();
      prisma.user.findUnique.mockResolvedValue({
        ...activeUser,
        status: 'PENDING_VERIFICATION',
        emailVerifiedAt: null,
        passwordHash: 'stored',
      });

      const result = await service.login(
        { email: 'aicha@boutique.sn', password: 'password-123' },
        {},
      );
      expect(result.user.status).toBe('PENDING_VERIFICATION');
    });
  });

  describe('refresh', () => {
    it('révoque la famille si l’utilisateur n’est plus actif', async () => {
      const { service, prisma, sessionService } = buildMocks();
      sessionService.rotate.mockResolvedValue({
        userId: 'user-1',
        familyId: 'family-1',
        issued: { sessionId: 's2', refreshToken: 'r2', expiresAt: FUTURE },
      });
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, status: 'DISABLED' });

      await expect(service.refresh('refresh-token', {})).rejects.toThrow(UserNotActiveError);
      expect(sessionService.revokeFamily).toHaveBeenCalledWith('family-1', expect.any(String));
    });
  });

  describe('forgotPassword', () => {
    it('email inconnu → réponse générique sans envoi', async () => {
      const { service, prisma, emailProvider } = buildMocks();
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.forgotPassword('ghost@nowhere.io', {});
      expect(result.message).toBeTruthy();
      expect(result.devLink).toBeUndefined();
      expect(emailProvider.send).not.toHaveBeenCalled();
    });

    it('email connu → envoi + lien exposé en dev', async () => {
      const { service, prisma, emailProvider } = buildMocks();
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'aicha@boutique.sn',
        status: 'ACTIVE',
      });

      const result = await service.forgotPassword('aicha@boutique.sn', {});
      expect(emailProvider.send).toHaveBeenCalledTimes(1);
      expect(result.devLink).toContain('/reset-password?token=');
    });

    it('hors development, le lien n’est jamais exposé', async () => {
      const { service, prisma } = buildMocks({ NODE_ENV: 'production' });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'aicha@boutique.sn',
        status: 'ACTIVE',
      });

      const result = await service.forgotPassword('aicha@boutique.sn', {});
      expect(result.devLink).toBeUndefined();
    });

    it('en development sans AUTH_EXPOSE_TEST_TOKENS, le lien n’est pas exposé', async () => {
      const { service, prisma } = buildMocks({ AUTH_EXPOSE_TEST_TOKENS: false });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'aicha@boutique.sn',
        status: 'ACTIVE',
      });

      const result = await service.forgotPassword('aicha@boutique.sn', {});
      expect(result.devLink).toBeUndefined();
    });
  });

  describe('verifyEmail', () => {
    it('token déjà consommé → InvalidVerificationTokenError', async () => {
      const { service, prisma } = buildMocks();
      prisma.emailVerificationToken.findUnique.mockResolvedValue({ id: 't1', userId: 'user-1' });
      prisma.emailVerificationToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.verifyEmail('used-token', {})).rejects.toThrow(
        InvalidVerificationTokenError,
      );
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('promeut le compte PENDING vers ACTIVE via updateMany conditionnel', async () => {
      const { service, prisma } = buildMocks();
      prisma.emailVerificationToken.findUnique.mockResolvedValue({ id: 't1', userId: 'user-1' });
      prisma.user.findUniqueOrThrow.mockResolvedValue(activeUser);

      await service.verifyEmail('valid-token', {});

      expect(prisma.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1', status: 'PENDING_VERIFICATION' },
          data: expect.objectContaining({ status: 'ACTIVE' }),
        }),
      );
    });
  });

  describe('changePassword', () => {
    it('mot de passe courant invalide → InvalidCredentialsError, rien n’est modifié', async () => {
      const { service, prisma, passwordService, sessionService } = buildMocks();
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'stored' });
      passwordService.verify.mockResolvedValue(false);

      await expect(
        service.changePassword('user-1', { currentPassword: 'bad', newPassword: 'new-pass-123' }, {}),
      ).rejects.toThrow(InvalidCredentialsError);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(sessionService.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('succès : change le hash, révoque toutes les sessions et en recrée une (transactionnel)', async () => {
      const { service, prisma, sessionService } = buildMocks();
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 'user-1', passwordHash: 'stored' })
        .mockResolvedValueOnce(activeUser);

      const result = await service.changePassword(
        'user-1',
        { currentPassword: 'old-pass-123', newPassword: 'new-pass-123' },
        { userAgent: 'jest' },
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ passwordHash: 'hashed:new-pass-123' }),
        }),
      );
      // Révocation + re-session passent par le client transactionnel (3e argument)
      expect(sessionService.revokeAllForUser).toHaveBeenCalledWith(
        'user-1',
        SESSION_REVOCATION_REASON.PASSWORD_CHANGED,
        prisma,
      );
      expect(sessionService.createSession).toHaveBeenCalledWith(
        'user-1',
        { userAgent: 'jest' },
        prisma,
      );
      expect(result.accessToken).toBe('signed-access-token');
      expect(result.refreshToken).toBe('new-refresh-token');
    });
  });
});
