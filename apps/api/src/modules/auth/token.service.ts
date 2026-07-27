import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface AccessTokenPayload {
  sub: string;
  sessionId: string;
  type: 'access';
}

const OPAQUE_TOKEN_BYTES = 32;

@Injectable()
export class TokenService {
  constructor(private readonly jwtService: JwtService) {}

  async signAccessToken(userId: string, sessionId: string): Promise<string> {
    const payload: AccessTokenPayload = { sub: userId, sessionId, type: 'access' };
    return this.jwtService.signAsync(payload);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    return this.jwtService.verifyAsync<AccessTokenPayload>(token);
  }

  /** Token opaque à haute entropie (256 bits) pour les refresh tokens et les tokens à usage unique. */
  generateOpaqueToken(): string {
    return randomBytes(OPAQUE_TOKEN_BYTES).toString('base64url');
  }

  /**
   * SHA-256, volontairement pas Argon2id : ces tokens ont déjà 256 bits d'entropie
   * (brute force infaisable quelle que soit la vitesse de hachage), et doivent rester
   * indexables en base pour une recherche en O(1) — ce qu'un hash salé aléatoirement
   * comme Argon2id ne permet pas.
   */
  hashOpaqueToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
