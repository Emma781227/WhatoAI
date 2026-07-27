import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { InvalidRefreshTokenError, RefreshTokenReuseDetectedError } from '@whauto/shared';

import type { PrismaService } from '../../prisma/prisma.service';
import { SESSION_REVOCATION_REASON, SessionService } from './session.service';
import { TokenService } from './token.service';

type SessionDelegateMock = {
  create: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
};

function buildMocks() {
  const sessionDelegate: SessionDelegateMock = {
    create: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const txSessionDelegate: SessionDelegateMock = {
    create: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const tx = { session: txSessionDelegate };
  const prisma = {
    session: sessionDelegate,
    $transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) =>
      callback(tx),
    ),
  } as unknown as PrismaService;

  const configService = {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      key === 'REFRESH_TOKEN_EXPIRES_IN_DAYS' ? 30 : defaultValue,
    ),
  } as unknown as ConfigService;

  const tokenService = new TokenService(
    new JwtService({ secret: 'unit-test-secret-at-least-32-characters-long' }),
  );

  const service = new SessionService(prisma, tokenService, configService);
  return { service, sessionDelegate, txSessionDelegate, tokenService, prisma };
}

describe('SessionService', () => {
  describe('createSession', () => {
    it('stocke uniquement le hash du token et ouvre une nouvelle famille', async () => {
      const { service, sessionDelegate, tokenService } = buildMocks();

      const issued = await service.createSession('user-1', { userAgent: 'jest', ipAddress: '::1' });

      expect(sessionDelegate.create).toHaveBeenCalledTimes(1);
      const data = sessionDelegate.create.mock.calls[0][0].data;
      expect(data.refreshTokenHash).toBe(tokenService.hashOpaqueToken(issued.refreshToken));
      expect(data.refreshTokenHash).not.toBe(issued.refreshToken);
      expect(data.familyId).toBe(data.id);
      expect(data.userId).toBe('user-1');
      expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('rotate', () => {
    const activeSession = {
      id: 'old-session',
      userId: 'user-1',
      familyId: 'family-1',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      replacedBySessionId: null,
    };

    it('consomme l’ancienne session et en crée une nouvelle dans la même famille', async () => {
      const { service, sessionDelegate, txSessionDelegate } = buildMocks();
      sessionDelegate.findUnique.mockResolvedValue(activeSession);

      const result = await service.rotate('raw-refresh-token', { userAgent: 'jest' });

      // Claim conditionnel de l'ancienne session
      const claim = txSessionDelegate.updateMany.mock.calls[0][0];
      expect(claim.where).toMatchObject({
        id: 'old-session',
        revokedAt: null,
        replacedBySessionId: null,
      });
      expect(claim.data.reason).toBe(SESSION_REVOCATION_REASON.ROTATED);

      // Nouvelle session : même famille, id pré-généré référencé par replacedBySessionId
      const created = txSessionDelegate.create.mock.calls[0][0].data;
      expect(created.familyId).toBe('family-1');
      expect(created.id).toBe(result.issued.sessionId);

      const linked = txSessionDelegate.update.mock.calls[0][0];
      expect(linked.where).toEqual({ id: 'old-session' });
      expect(linked.data.replacedBySessionId).toBe(result.issued.sessionId);

      expect(result.userId).toBe('user-1');
      expect(result.issued.refreshToken).not.toBe('raw-refresh-token');
    });

    it('rejette un token inconnu', async () => {
      const { service, sessionDelegate } = buildMocks();
      sessionDelegate.findUnique.mockResolvedValue(null);

      await expect(service.rotate('unknown', {})).rejects.toThrow(InvalidRefreshTokenError);
    });

    it('rejette un token expiré', async () => {
      const { service, sessionDelegate } = buildMocks();
      sessionDelegate.findUnique.mockResolvedValue({
        ...activeSession,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.rotate('expired', {})).rejects.toThrow(InvalidRefreshTokenError);
    });

    it('révoque toute la famille si un token déjà consommé est rejoué', async () => {
      const { service, sessionDelegate } = buildMocks();
      sessionDelegate.findUnique.mockResolvedValue({
        ...activeSession,
        revokedAt: new Date(),
        replacedBySessionId: 'newer-session',
      });

      await expect(service.rotate('replayed', {})).rejects.toThrow(
        RefreshTokenReuseDetectedError,
      );

      expect(sessionDelegate.updateMany).toHaveBeenCalledWith({
        where: { familyId: 'family-1', revokedAt: null },
        data: expect.objectContaining({ reason: SESSION_REVOCATION_REASON.REUSE_DETECTED }),
      });
    });

    it('deux refresh concurrents : le perdant (count=0) échoue sans créer de session', async () => {
      const { service, sessionDelegate, txSessionDelegate } = buildMocks();
      sessionDelegate.findUnique.mockResolvedValue(activeSession);
      txSessionDelegate.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.rotate('contested', {})).rejects.toThrow(InvalidRefreshTokenError);
      expect(txSessionDelegate.create).not.toHaveBeenCalled();
      expect(txSessionDelegate.update).not.toHaveBeenCalled();
    });
  });

  describe('revokeByRefreshToken', () => {
    it('est idempotent : token inconnu ou déjà révoqué → null, sans erreur', async () => {
      const { service, sessionDelegate } = buildMocks();

      sessionDelegate.findUnique.mockResolvedValueOnce(null);
      await expect(service.revokeByRefreshToken('unknown', 'LOGOUT')).resolves.toBeNull();

      sessionDelegate.findUnique.mockResolvedValueOnce({ id: 's', revokedAt: new Date() });
      await expect(service.revokeByRefreshToken('revoked', 'LOGOUT')).resolves.toBeNull();
      expect(sessionDelegate.update).not.toHaveBeenCalled();
    });
  });
});
