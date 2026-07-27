import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

import type { AccessTokenPayload } from './token.service';

export interface AuthenticatedUser {
  userId: string;
  sessionId: string;
}

export interface RequestWithUser extends Request {
  user: AuthenticatedUser;
}

/**
 * Garde JWT maison (pas de passport) : extrait le Bearer token, le vérifie via
 * JwtService (signature + expiration), et attache { userId, sessionId } à la requête.
 * Volontairement stateless : la validité de la session n'est re-vérifiée en base
 * qu'au refresh — un access token reste valable au plus JWT_ACCESS_EXPIRES_IN
 * après une révocation.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing access token');
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(header.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    if (payload.type !== 'access' || !payload.sub || !payload.sessionId) {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    request.user = { userId: payload.sub, sessionId: payload.sessionId };
    return true;
  }
}
