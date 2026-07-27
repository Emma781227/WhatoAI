import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { EmailNotVerifiedError, UserNotActiveError } from '@whauto/shared';

import { PrismaService } from '../../prisma/prisma.service';
import type { RequestWithUser } from './jwt-auth.guard';

/**
 * PRÉPARÉ MAIS PAS ENCORE APPLIQUÉ (voir CLAUDE.md) : aucun endpoint actuel ne
 * l'utilise. Les futurs modules métier (Organizations, Shops…) le poseront
 * après JwtAuthGuard pour exiger un email vérifié :
 *
 *   @UseGuards(JwtAuthGuard, EmailVerifiedGuard)
 *
 * Les endpoints auth (me, refresh, resend-verification, logout) restent
 * accessibles aux comptes PENDING_VERIFICATION.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    const user = await this.prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { status: true, emailVerifiedAt: true },
    });

    if (!user || user.status === 'SUSPENDED' || user.status === 'DISABLED') {
      throw new UserNotActiveError();
    }
    if (user.emailVerifiedAt === null) {
      throw new EmailNotVerifiedError();
    }
    return true;
  }
}
