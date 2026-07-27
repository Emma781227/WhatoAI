import { JwtService } from '@nestjs/jwt';

import { TokenService } from './token.service';

const SECRET = 'unit-test-secret-at-least-32-characters-long';

describe('TokenService', () => {
  const jwtService = new JwtService({ secret: SECRET, signOptions: { expiresIn: '15m' } });
  const service = new TokenService(jwtService);

  it('signe puis vérifie un access token (aller-retour)', async () => {
    const token = await service.signAccessToken('user-1', 'session-1');
    const payload = await service.verifyAccessToken(token);
    expect(payload).toMatchObject({ sub: 'user-1', sessionId: 'session-1', type: 'access' });
  });

  it('rejette un token signé avec un autre secret', async () => {
    const otherJwt = new JwtService({ secret: 'another-secret-also-32-characters-xx' });
    const forged = await otherJwt.signAsync({ sub: 'user-1', sessionId: 's', type: 'access' });
    await expect(service.verifyAccessToken(forged)).rejects.toThrow();
  });

  it('rejette un token expiré', async () => {
    const expired = await jwtService.signAsync(
      { sub: 'user-1', sessionId: 's', type: 'access' },
      { expiresIn: '-10s' },
    );
    await expect(service.verifyAccessToken(expired)).rejects.toThrow();
  });

  it('génère des tokens opaques uniques à haute entropie', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => service.generateOpaqueToken()));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      // 32 octets en base64url = 43 caractères, sans padding.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('hashe les tokens opaques de façon déterministe (SHA-256 hex)', () => {
    const token = service.generateOpaqueToken();
    const first = service.hashOpaqueToken(token);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(service.hashOpaqueToken(token)).toBe(first);
    expect(service.hashOpaqueToken(service.generateOpaqueToken())).not.toBe(first);
  });
});
