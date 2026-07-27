import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import type { RequestWithUser } from './jwt-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';

const SECRET = 'unit-test-secret-at-least-32-characters-long';

function contextFor(authorization?: string): { context: ExecutionContext; request: RequestWithUser } {
  const request = { headers: { authorization } } as RequestWithUser;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('JwtAuthGuard', () => {
  const jwtService = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });
  const guard = new JwtAuthGuard(jwtService);

  it('accepte un token valide et attache { userId, sessionId } à la requête', async () => {
    const token = await jwtService.signAsync({ sub: 'user-1', sessionId: 'session-1', type: 'access' });
    const { context, request } = contextFor(`Bearer ${token}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({ userId: 'user-1', sessionId: 'session-1' });
  });

  it('rejette une requête sans header Authorization', async () => {
    const { context } = contextFor(undefined);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejette un header non Bearer', async () => {
    const { context } = contextFor('Basic dXNlcjpwYXNz');
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejette un token illisible', async () => {
    const { context } = contextFor('Bearer not-a-jwt');
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejette un token signé avec un autre secret', async () => {
    const forged = await new JwtService({ secret: 'other-secret-that-is-32-characters!!' }).signAsync(
      { sub: 'user-1', sessionId: 's', type: 'access' },
    );
    const { context } = contextFor(`Bearer ${forged}`);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejette un token expiré', async () => {
    const expired = await jwtService.signAsync(
      { sub: 'user-1', sessionId: 's', type: 'access' },
      { expiresIn: '-10s' },
    );
    const { context } = contextFor(`Bearer ${expired}`);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejette un payload qui n’est pas de type access', async () => {
    const wrongType = await jwtService.signAsync({ sub: 'user-1', sessionId: 's', type: 'refresh' });
    const { context } = contextFor(`Bearer ${wrongType}`);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });
});
