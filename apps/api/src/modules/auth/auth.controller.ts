import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { InvalidRefreshTokenError } from '@whauto/shared';
import type { CookieOptions, Request, Response } from 'express';

import { AuthThrottle } from './auth-throttle.decorator';
import type { AuthenticatedResult } from './auth.service';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import {
  AuthSessionResponseDto,
  LogoutAllResponseDto,
  MessageResponseDto,
  UserResponseDto,
} from './dto/auth-responses.dto';
import type { AuthenticatedUser } from './jwt-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { SessionContext } from './session.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post('register')
  @AuthThrottle('register')
  @ApiOperation({ summary: 'Créer un compte (envoie un email de vérification)' })
  @ApiCreatedResponse({ type: MessageResponseDto })
  async register(@Body() dto: RegisterDto, @Req() req: Request): Promise<MessageResponseDto> {
    const result = await this.authService.register(dto, this.contextOf(req));
    return MessageResponseDto.from(result);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @AuthThrottle('login')
  @ApiOperation({ summary: 'Connexion — pose le refresh token en cookie HttpOnly' })
  @ApiOkResponse({ type: AuthSessionResponseDto })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionResponseDto> {
    const result = await this.authService.login(dto, this.contextOf(req));
    this.setRefreshCookie(res, result);
    return AuthSessionResponseDto.from(result.user, result.accessToken);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @AuthThrottle('refresh')
  @ApiOperation({ summary: 'Rotation du refresh token (cookie) + nouvel access token' })
  @ApiOkResponse({ type: AuthSessionResponseDto })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionResponseDto> {
    const refreshToken = this.readRefreshCookie(req);
    if (!refreshToken) {
      throw new InvalidRefreshTokenError();
    }
    const result = await this.authService.refresh(refreshToken, this.contextOf(req));
    this.setRefreshCookie(res, result);
    return AuthSessionResponseDto.from(result.user, result.accessToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Déconnexion de la session courante (idempotent)' })
  @ApiNoContentResponse()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.authService.logout(this.readRefreshCookie(req), this.contextOf(req));
    this.clearRefreshCookie(res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Révoquer toutes les sessions de l’utilisateur' })
  @ApiOkResponse({ type: LogoutAllResponseDto })
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LogoutAllResponseDto> {
    const result = await this.authService.logoutAll(user.userId, this.contextOf(req));
    this.clearRefreshCookie(res);
    return result;
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Profil de l’utilisateur courant' })
  @ApiOkResponse({ type: UserResponseDto })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<UserResponseDto> {
    return UserResponseDto.fromUser(await this.authService.me(user.userId));
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Vérifier l’adresse email via le token reçu' })
  @ApiOkResponse({ type: UserResponseDto })
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request): Promise<UserResponseDto> {
    return UserResponseDto.fromUser(
      await this.authService.verifyEmail(dto.token, this.contextOf(req)),
    );
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @AuthThrottle('resend-verification')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Renvoyer l’email de vérification' })
  @ApiOkResponse({ type: MessageResponseDto })
  async resendVerification(@CurrentUser() user: AuthenticatedUser): Promise<MessageResponseDto> {
    return MessageResponseDto.from(await this.authService.resendVerification(user.userId));
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @AuthThrottle('forgot-password')
  @ApiOperation({ summary: 'Demander un lien de réinitialisation (réponse générique)' })
  @ApiOkResponse({ type: MessageResponseDto })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: Request,
  ): Promise<MessageResponseDto> {
    return MessageResponseDto.from(
      await this.authService.forgotPassword(dto.email, this.contextOf(req)),
    );
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @AuthThrottle('reset')
  @ApiOperation({ summary: 'Réinitialiser le mot de passe (révoque toutes les sessions)' })
  @ApiOkResponse({ type: MessageResponseDto })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: Request,
  ): Promise<MessageResponseDto> {
    await this.authService.resetPassword(dto.token, dto.newPassword, this.contextOf(req));
    return MessageResponseDto.from({
      message: 'Password has been reset. Please log in with your new password.',
    });
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Changer le mot de passe — révoque toutes les sessions et en recrée une',
  })
  @ApiOkResponse({ type: AuthSessionResponseDto })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionResponseDto> {
    const result = await this.authService.changePassword(user.userId, dto, this.contextOf(req));
    this.setRefreshCookie(res, result);
    return AuthSessionResponseDto.from(result.user, result.accessToken);
  }

  // ------------------------------------------------------------------- helpers

  private contextOf(req: Request): SessionContext {
    return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
  }

  private cookieName(): string {
    return this.configService.get<string>('COOKIE_NAME', 'whauto_refresh');
  }

  private readRefreshCookie(req: Request): string | undefined {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    return cookies?.[this.cookieName()];
  }

  /**
   * Cookie limité à path=/api/auth : le refresh token n'est jamais envoyé sur le
   * reste de l'API. Host-only par défaut (COOKIE_DOMAIN volontairement absent).
   */
  private cookieOptions(): CookieOptions {
    const options: CookieOptions = {
      httpOnly: true,
      secure: this.configService.get<boolean>('COOKIE_SECURE') === true,
      sameSite: this.configService.get<'lax' | 'strict' | 'none'>('COOKIE_SAME_SITE', 'strict'),
      path: '/api/auth',
    };
    const domain = this.configService.get<string>('COOKIE_DOMAIN');
    if (domain) {
      options.domain = domain;
    }
    return options;
  }

  private setRefreshCookie(res: Response, result: AuthenticatedResult): void {
    res.cookie(this.cookieName(), result.refreshToken, {
      ...this.cookieOptions(),
      expires: result.refreshTokenExpiresAt,
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(this.cookieName(), this.cookieOptions());
  }
}
