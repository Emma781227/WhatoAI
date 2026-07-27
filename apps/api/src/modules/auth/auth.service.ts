import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthAuditEventType, Prisma } from '@whauto/database';
import {
  EmailAlreadyUsedError,
  InvalidCredentialsError,
  InvalidPasswordResetTokenError,
  InvalidVerificationTokenError,
  UserNotActiveError,
} from '@whauto/shared';

import { PrismaService } from '../../prisma/prisma.service';
import { EMAIL_PROVIDER } from '../email/email-provider.interface';
import type { EmailProvider } from '../email/email-provider.interface';
import { USER_PUBLIC_SELECT } from './auth.mapper';
import type { UserPublic } from './auth.mapper';
import { PasswordService } from './password.service';
import { SESSION_REVOCATION_REASON, SessionService } from './session.service';
import type { SessionContext } from './session.service';
import { TokenService } from './token.service';

export interface AuthenticatedResult {
  user: UserPublic;
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface GenericMessageResult {
  message: string;
  /** Présent uniquement en development avec AUTH_EXPOSE_TEST_TOKENS=true. */
  devLink?: string;
}

const REGISTER_MESSAGE =
  'Registration processed. If needed, a verification email has been sent to this address.';
const FORGOT_PASSWORD_MESSAGE =
  'If an account exists for this email, a password reset link has been sent.';
const RESEND_VERIFICATION_MESSAGE =
  'If your email address is not verified yet, a new verification email has been sent.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly configService: ConfigService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
  ) {}

  // ------------------------------------------------------------------ register

  async register(
    input: { email: string; password: string; firstName: string; lastName: string },
    context: SessionContext,
  ): Promise<GenericMessageResult> {
    const email = this.normalizeEmail(input.email);

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, status: true },
    });

    if (existing) {
      if (existing.status !== 'PENDING_VERIFICATION') {
        throw new EmailAlreadyUsedError();
      }
      // Compte existant non vérifié : on ne recrée rien et on ne touche pas au
      // mot de passe existant (sinon n'importe qui pourrait écraser un compte
      // en attente) — on renvoie simplement un nouveau lien de vérification.
      const verificationUrl = await this.issueEmailVerificationToken(existing.id, email);
      return { message: REGISTER_MESSAGE, devLink: this.maybeExpose(verificationUrl) };
    }

    this.passwordService.validateStrength(input.password);
    const passwordHash = await this.passwordService.hash(input.password);

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
      },
      select: { id: true, email: true },
    });

    const verificationUrl = await this.issueEmailVerificationToken(user.id, user.email);
    await this.audit('REGISTER_SUCCESS', user.id, context);

    return { message: REGISTER_MESSAGE, devLink: this.maybeExpose(verificationUrl) };
  }

  // --------------------------------------------------------------------- login

  async login(
    input: { email: string; password: string },
    context: SessionContext,
  ): Promise<AuthenticatedResult> {
    const email = this.normalizeEmail(input.email);

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { ...USER_PUBLIC_SELECT, passwordHash: true },
    });

    if (!user) {
      // Réponse identique email inconnu / mot de passe faux (pas d'énumération).
      await this.audit('LOGIN_FAILED', null, context, { email });
      throw new InvalidCredentialsError();
    }

    const passwordValid = await this.passwordService.verify(user.passwordHash, input.password);
    if (!passwordValid) {
      await this.audit('LOGIN_FAILED', user.id, context);
      throw new InvalidCredentialsError();
    }

    if (user.status === 'SUSPENDED' || user.status === 'DISABLED') {
      await this.audit('LOGIN_FAILED', user.id, context, { reason: user.status });
      throw new UserNotActiveError();
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
      select: { id: true },
    });

    const issued = await this.sessionService.createSession(user.id, context);
    const accessToken = await this.tokenService.signAccessToken(user.id, issued.sessionId);
    await this.audit('LOGIN_SUCCESS', user.id, context);

    const { passwordHash, ...publicUser } = user;
    void passwordHash;
    return {
      user: publicUser,
      accessToken,
      refreshToken: issued.refreshToken,
      refreshTokenExpiresAt: issued.expiresAt,
    };
  }

  // ------------------------------------------------------------------- refresh

  async refresh(refreshToken: string, context: SessionContext): Promise<AuthenticatedResult> {
    const rotation = await this.sessionService.rotate(refreshToken, context);

    const user = await this.prisma.user.findUnique({
      where: { id: rotation.userId },
      select: USER_PUBLIC_SELECT,
    });

    if (!user || user.status === 'SUSPENDED' || user.status === 'DISABLED') {
      await this.sessionService.revokeFamily(
        rotation.familyId,
        SESSION_REVOCATION_REASON.LOGOUT_ALL,
      );
      throw new UserNotActiveError();
    }

    const accessToken = await this.tokenService.signAccessToken(user.id, rotation.issued.sessionId);
    await this.audit('REFRESH_SUCCESS', user.id, context);

    return {
      user,
      accessToken,
      refreshToken: rotation.issued.refreshToken,
      refreshTokenExpiresAt: rotation.issued.expiresAt,
    };
  }

  // -------------------------------------------------------------------- logout

  async logout(refreshToken: string | undefined, context: SessionContext): Promise<void> {
    if (!refreshToken) {
      return;
    }
    const revoked = await this.sessionService.revokeByRefreshToken(
      refreshToken,
      SESSION_REVOCATION_REASON.LOGOUT,
    );
    if (revoked) {
      await this.audit('LOGOUT', revoked.userId, context);
    }
  }

  async logoutAll(userId: string, context: SessionContext): Promise<{ revokedSessions: number }> {
    const revokedSessions = await this.sessionService.revokeAllForUser(
      userId,
      SESSION_REVOCATION_REASON.LOGOUT_ALL,
    );
    await this.audit('LOGOUT_ALL', userId, context);
    return { revokedSessions };
  }

  // ------------------------------------------------------------------------ me

  async me(userId: string): Promise<UserPublic> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_PUBLIC_SELECT,
    });
    if (!user) {
      // Le JWT référence un utilisateur supprimé entre-temps.
      throw new InvalidCredentialsError();
    }
    return user;
  }

  // -------------------------------------------------------------- verify email

  async verifyEmail(token: string, context: SessionContext): Promise<UserPublic> {
    const tokenHash = this.tokenService.hashOpaqueToken(token);
    const now = new Date();

    const record = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true },
    });
    if (!record) {
      throw new InvalidVerificationTokenError();
    }

    const user = await this.prisma.$transaction(async (tx) => {
      // Consommation atomique : un seul appel concurrent peut marquer usedAt.
      const consumed = await tx.emailVerificationToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) {
        throw new InvalidVerificationTokenError();
      }

      // updateMany conditionnel : ne promeut que depuis PENDING_VERIFICATION
      // (ne réactive jamais un compte SUSPENDED/DISABLED).
      await tx.user.updateMany({
        where: { id: record.userId, status: 'PENDING_VERIFICATION' },
        data: { status: 'ACTIVE', emailVerifiedAt: now },
      });

      return tx.user.findUniqueOrThrow({
        where: { id: record.userId },
        select: USER_PUBLIC_SELECT,
      });
    });

    await this.audit('EMAIL_VERIFIED', user.id, context);
    return user;
  }

  async resendVerification(userId: string): Promise<GenericMessageResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });

    if (!user || user.emailVerifiedAt !== null) {
      return { message: RESEND_VERIFICATION_MESSAGE };
    }

    const verificationUrl = await this.issueEmailVerificationToken(user.id, user.email);
    return { message: RESEND_VERIFICATION_MESSAGE, devLink: this.maybeExpose(verificationUrl) };
  }

  // ------------------------------------------------------------ password reset

  async forgotPassword(email: string, context: SessionContext): Promise<GenericMessageResult> {
    const normalizedEmail = this.normalizeEmail(email);
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, status: true },
    });

    // Réponse générique dans tous les cas (pas d'énumération d'emails).
    if (!user || user.status === 'SUSPENDED' || user.status === 'DISABLED') {
      return { message: FORGOT_PASSWORD_MESSAGE };
    }

    const expiresInMinutes = this.configService.get<number>(
      'PASSWORD_RESET_EXPIRES_IN_MINUTES',
      30,
    );
    const resetToken = this.tokenService.generateOpaqueToken();

    await this.prisma.$transaction([
      // Un seul token actif à la fois : les précédents non utilisés sont invalidés.
      this.prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: this.tokenService.hashOpaqueToken(resetToken),
          expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000),
        },
      }),
    ]);

    const resetUrl = `${this.webUrl()}/reset-password?token=${resetToken}`;
    await this.emailProvider.send({
      to: user.email,
      subject: 'Réinitialisation de votre mot de passe Whauto AI',
      text: `Pour réinitialiser votre mot de passe, ouvrez ce lien (valable ${expiresInMinutes} minutes) :\n${resetUrl}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet email.`,
    });
    await this.audit('PASSWORD_RESET_REQUESTED', user.id, context);

    return { message: FORGOT_PASSWORD_MESSAGE, devLink: this.maybeExpose(resetUrl) };
  }

  async resetPassword(
    token: string,
    newPassword: string,
    context: SessionContext,
  ): Promise<void> {
    const tokenHash = this.tokenService.hashOpaqueToken(token);
    const now = new Date();

    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true },
    });
    if (!record) {
      throw new InvalidPasswordResetTokenError();
    }

    this.passwordService.validateStrength(newPassword);
    const passwordHash = await this.passwordService.hash(newPassword);

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) {
        throw new InvalidPasswordResetTokenError();
      }

      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash, passwordChangedAt: now },
        select: { id: true },
      });

      await this.sessionService.revokeAllForUser(
        record.userId,
        SESSION_REVOCATION_REASON.PASSWORD_RESET,
        tx,
      );
    });

    await this.audit('PASSWORD_RESET_COMPLETED', record.userId, context);
  }

  // ----------------------------------------------------------- change password

  /**
   * Changement de mot de passe (authentifié) — spec point 7 :
   * vérifier currentPassword, changer le hash, révoquer TOUTES les sessions
   * (y compris la courante), recréer immédiatement une session — le tout dans
   * une transaction — puis émettre de nouveaux access + refresh tokens.
   */
  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
    context: SessionContext,
  ): Promise<AuthenticatedResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, passwordHash: true },
    });
    if (!user) {
      throw new InvalidCredentialsError();
    }

    const currentValid = await this.passwordService.verify(
      user.passwordHash,
      input.currentPassword,
    );
    if (!currentValid) {
      throw new InvalidCredentialsError();
    }

    this.passwordService.validateStrength(input.newPassword);
    await this.passwordService.assertNotReused(input.newPassword, user.passwordHash);
    const passwordHash = await this.passwordService.hash(input.newPassword);
    const now = new Date();

    const issued = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: now },
        select: { id: true },
      });
      await this.sessionService.revokeAllForUser(
        userId,
        SESSION_REVOCATION_REASON.PASSWORD_CHANGED,
        tx,
      );
      return this.sessionService.createSession(userId, context, tx);
    });

    const accessToken = await this.tokenService.signAccessToken(userId, issued.sessionId);
    await this.audit('PASSWORD_CHANGED', userId, context);

    const publicUser = await this.me(userId);
    return {
      user: publicUser,
      accessToken,
      refreshToken: issued.refreshToken,
      refreshTokenExpiresAt: issued.expiresAt,
    };
  }

  // ------------------------------------------------------------------- helpers

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private webUrl(): string {
    return this.configService.get<string>('APP_WEB_URL', 'http://localhost:3000');
  }

  /** Le lien (token brut inclus) n'est exposé qu'en development avec le flag explicite. */
  private maybeExpose(link: string): string | undefined {
    const isDevelopment = this.configService.get<string>('NODE_ENV') === 'development';
    const exposeEnabled = this.configService.get<boolean>('AUTH_EXPOSE_TEST_TOKENS') === true;
    return isDevelopment && exposeEnabled ? link : undefined;
  }

  private async issueEmailVerificationToken(userId: string, email: string): Promise<string> {
    const expiresInHours = this.configService.get<number>(
      'EMAIL_VERIFICATION_EXPIRES_IN_HOURS',
      24,
    );
    const token = this.tokenService.generateOpaqueToken();

    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.deleteMany({ where: { userId, usedAt: null } }),
      this.prisma.emailVerificationToken.create({
        data: {
          userId,
          tokenHash: this.tokenService.hashOpaqueToken(token),
          expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000),
        },
      }),
    ]);

    const verificationUrl = `${this.webUrl()}/verify-email?token=${token}`;
    await this.emailProvider.send({
      to: email,
      subject: 'Vérifiez votre adresse email Whauto AI',
      text: `Bienvenue sur Whauto AI !\nPour vérifier votre adresse email, ouvrez ce lien (valable ${expiresInHours} heures) :\n${verificationUrl}`,
    });

    return verificationUrl;
  }

  private async audit(
    eventType: AuthAuditEventType,
    userId: string | null,
    context: SessionContext,
    metadata?: Prisma.InputJsonValue,
  ): Promise<void> {
    try {
      await this.prisma.authAuditEvent.create({
        data: {
          eventType,
          userId,
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent ?? null,
          metadata,
        },
      });
    } catch (error) {
      // L'audit ne doit jamais faire échouer le flux métier.
      this.logger.error(`Échec d'écriture de l'événement d'audit ${eventType}`, error);
    }
  }
}
