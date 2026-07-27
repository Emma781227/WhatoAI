import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, Session } from '@whauto/database';
import { InvalidRefreshTokenError, RefreshTokenReuseDetectedError } from '@whauto/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from './token.service';

export interface SessionContext {
  userAgent?: string;
  ipAddress?: string;
}

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

export const SESSION_REVOCATION_REASON = {
  ROTATED: 'ROTATED',
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  REUSE_DETECTED: 'REUSE_DETECTED',
} as const;

type PrismaClientLike = PrismaService | Prisma.TransactionClient;

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly configService: ConfigService,
  ) {}

  private refreshTokenExpiry(): Date {
    const days = this.configService.get<number>('REFRESH_TOKEN_EXPIRES_IN_DAYS', 30);
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  /**
   * Crée une session dans une nouvelle famille (login, reset password, change password).
   * Accepte un TransactionClient pour participer à une transaction englobante
   * (ex. change-password : révocation de toutes les sessions + re-session atomiques).
   */
  async createSession(
    userId: string,
    context: SessionContext,
    client: PrismaClientLike = this.prisma,
  ): Promise<IssuedSession> {
    const refreshToken = this.tokenService.generateOpaqueToken();
    const expiresAt = this.refreshTokenExpiry();
    // familyId = id de la première session de la famille.
    const sessionId = randomUUID();

    await client.session.create({
      data: {
        id: sessionId,
        userId,
        familyId: sessionId,
        refreshTokenHash: this.tokenService.hashOpaqueToken(refreshToken),
        userAgent: context.userAgent ?? null,
        ipAddress: context.ipAddress ?? null,
        expiresAt,
      },
    });

    return { sessionId, refreshToken, expiresAt };
  }

  /**
   * Consommation atomique d'un refresh token (rotation).
   *
   * Garantie anti-concurrence : le `updateMany` conditionnel (revokedAt=null,
   * replacedBySessionId=null, expiresAt>now) est atomique au niveau ligne —
   * si deux refresh simultanés arrivent avec le même token, un seul updateMany
   * retourne count=1 ; l'autre voit count=0 et la transaction est annulée
   * (la session créée en aval n'est jamais committée). L'isolation Read Committed
   * par défaut de PostgreSQL suffit : pas besoin de Serializable, le conflit est
   * résolu par le verrou de ligne posé par le premier UPDATE.
   *
   * Détection de réutilisation : un token retrouvé mais déjà révoqué/remplacé
   * signifie qu'un token consommé a été rejoué (vol probable) → révocation de
   * toute la famille.
   */
  async rotate(
    refreshToken: string,
    context: SessionContext,
  ): Promise<{ userId: string; familyId: string; issued: IssuedSession }> {
    const tokenHash = this.tokenService.hashOpaqueToken(refreshToken);
    const now = new Date();

    const current = await this.prisma.session.findUnique({
      where: { refreshTokenHash: tokenHash },
      select: {
        id: true,
        userId: true,
        familyId: true,
        expiresAt: true,
        revokedAt: true,
        replacedBySessionId: true,
      },
    });

    if (!current) {
      throw new InvalidRefreshTokenError();
    }

    if (current.revokedAt !== null || current.replacedBySessionId !== null) {
      await this.revokeFamily(current.familyId, SESSION_REVOCATION_REASON.REUSE_DETECTED);
      this.logger.warn(
        `Réutilisation de refresh token détectée — famille ${current.familyId} révoquée`,
      );
      throw new RefreshTokenReuseDetectedError();
    }

    if (current.expiresAt <= now) {
      throw new InvalidRefreshTokenError();
    }

    // Id de la nouvelle session généré avant la transaction (exigence de la spec) :
    // il est référencé par replacedBySessionId une fois la nouvelle ligne créée.
    const newSessionId = randomUUID();
    const newRefreshToken = this.tokenService.generateOpaqueToken();
    const newExpiresAt = this.refreshTokenExpiry();

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.session.updateMany({
        where: {
          id: current.id,
          revokedAt: null,
          replacedBySessionId: null,
          expiresAt: { gt: now },
        },
        data: {
          revokedAt: now,
          lastUsedAt: now,
          reason: SESSION_REVOCATION_REASON.ROTATED,
        },
      });

      if (claimed.count !== 1) {
        // Un refresh concurrent a consommé le token entre notre lecture et ce point.
        throw new InvalidRefreshTokenError();
      }

      await tx.session.create({
        data: {
          id: newSessionId,
          userId: current.userId,
          familyId: current.familyId,
          refreshTokenHash: this.tokenService.hashOpaqueToken(newRefreshToken),
          userAgent: context.userAgent ?? null,
          ipAddress: context.ipAddress ?? null,
          expiresAt: newExpiresAt,
        },
      });

      await tx.session.update({
        where: { id: current.id },
        data: { replacedBySessionId: newSessionId },
      });
    });

    return {
      userId: current.userId,
      familyId: current.familyId,
      issued: { sessionId: newSessionId, refreshToken: newRefreshToken, expiresAt: newExpiresAt },
    };
  }

  /** Logout : idempotent — un token inconnu ou déjà révoqué ne produit pas d'erreur. */
  async revokeByRefreshToken(refreshToken: string, reason: string): Promise<Session | null> {
    const tokenHash = this.tokenService.hashOpaqueToken(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: tokenHash },
      select: { id: true, revokedAt: true },
    });
    if (!session || session.revokedAt !== null) {
      return null;
    }
    return this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), reason },
    });
  }

  async revokeFamily(familyId: string, reason: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), reason },
    });
    return result.count;
  }

  async revokeAllForUser(
    userId: string,
    reason: string,
    client: PrismaClientLike = this.prisma,
  ): Promise<number> {
    const result = await client.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), reason },
    });
    return result.count;
  }
}
