import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

export interface CleanupResult {
  sessions: number;
  emailVerificationTokens: number;
  passwordResetTokens: number;
}

/** Rétention des sessions expirées/révoquées avant purge (piste d'audit courte). */
const SESSION_RETENTION_DAYS = 30;

/**
 * Nettoyage des sessions et tokens à usage unique périmés.
 * Volontairement sans planificateur : sera appelé plus tard par le worker
 * (BullMQ repeatable job) ou une commande CLI. Idempotent, sans état.
 */
@Injectable()
export class AuthCleanupService {
  private readonly logger = new Logger(AuthCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  async cleanupExpired(now: Date = new Date()): Promise<CleanupResult> {
    const sessionCutoff = new Date(now.getTime() - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const [sessions, emailVerificationTokens, passwordResetTokens] =
      await this.prisma.$transaction([
        this.prisma.session.deleteMany({
          where: {
            OR: [{ expiresAt: { lt: sessionCutoff } }, { revokedAt: { lt: sessionCutoff } }],
          },
        }),
        this.prisma.emailVerificationToken.deleteMany({
          where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
        }),
        this.prisma.passwordResetToken.deleteMany({
          where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
        }),
      ]);

    const result: CleanupResult = {
      sessions: sessions.count,
      emailVerificationTokens: emailVerificationTokens.count,
      passwordResetTokens: passwordResetTokens.count,
    };
    this.logger.log(
      `Nettoyage auth : ${result.sessions} sessions, ${result.emailVerificationTokens} tokens de vérification, ${result.passwordResetTokens} tokens de reset supprimés`,
    );
    return result;
  }
}
