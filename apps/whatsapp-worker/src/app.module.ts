import { resolve } from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { workerEnvSchema } from '@whauto/config';
import { LoggerModule } from 'nestjs-pino';

import { AiModule } from './ai/ai.module';
import { CartsWorkerModule } from './carts/carts.module';
import { ConnectivityModule } from './connectivity/connectivity.module';
import { PrismaModule } from './prisma/prisma.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // `nest start` exécute avec cwd = apps/whatsapp-worker : on cherche d'abord un .env
      // local, puis on retombe sur le .env à la racine du monorepo.
      envFilePath: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')],
      validate: (raw: Record<string, string | undefined>) => workerEnvSchema.parse(raw),
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        pinoHttp: {
          level: configService.get<string>('LOG_LEVEL', 'info'),
          transport:
            configService.get<string>('NODE_ENV') !== 'production'
              ? { target: 'pino-pretty' }
              : undefined,
        },
      }),
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    ConnectivityModule,
    AiModule,
    WhatsAppModule,
    CartsWorkerModule,
  ],
})
export class AppModule {}
