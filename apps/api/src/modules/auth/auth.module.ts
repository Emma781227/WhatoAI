import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { JwtModuleOptions, JwtSignOptions } from '@nestjs/jwt';
import { seconds, ThrottlerModule } from '@nestjs/throttler';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT, RedisModule } from '../../redis/redis.module';
import { EmailModule } from '../email/email.module';
import { AuthCleanupService } from './auth-cleanup.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailVerifiedGuard } from './email-verified.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    EmailModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtModuleOptions => ({
        secret: configService.get<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          // Format déjà validé par Zod ; le type `ms.StringValue` de @nestjs/jwt
          // n'est pas exprimable depuis une variable d'environnement.
          expiresIn: configService.get<string>(
            'JWT_ACCESS_EXPIRES_IN',
            '15m',
          ) as JwtSignOptions['expiresIn'],
        },
      }),
    }),
    // Rate limiting Redis. Compatibilité vérifiée le 2026-07-12 :
    // @nest-lab/throttler-storage-redis@1.2.0 déclare comme peer dependencies
    // @nestjs/common+core ^11, @nestjs/throttler >=6 et ioredis >=5 — notre
    // stack (NestJS 11, throttler 6.5, ioredis 5.4) est couverte.
    ThrottlerModule.forRootAsync({
      imports: [RedisModule],
      inject: [ConfigService, REDIS_CLIENT],
      useFactory: (configService: ConfigService, redis: Redis): ThrottlerModuleOptions => {
        const bucket = (name: string, envPrefix: string) => ({
          name,
          limit: configService.get<number>(`AUTH_RATE_LIMIT_${envPrefix}_MAX`) as number,
          ttl: seconds(
            configService.get<number>(`AUTH_RATE_LIMIT_${envPrefix}_WINDOW_SECONDS`) as number,
          ),
        });
        return {
          throttlers: [
            bucket('login', 'LOGIN'),
            bucket('register', 'REGISTER'),
            bucket('refresh', 'REFRESH'),
            bucket('reset', 'RESET'),
            bucket('forgot-password', 'FORGOT_PASSWORD'),
            bucket('resend-verification', 'RESEND_VERIFICATION'),
          ],
          storage: new ThrottlerStorageRedisService(redis),
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    PasswordService,
    TokenService,
    AuthCleanupService,
    JwtAuthGuard,
    EmailVerifiedGuard,
  ],
  // JwtModule exporté pour que les futurs modules puissent poser JwtAuthGuard.
  // TokenService exporté pour les tokens opaques hors auth (invitations…).
  exports: [JwtAuthGuard, EmailVerifiedGuard, JwtModule, TokenService],
})
export class AuthModule {}
