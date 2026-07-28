import { resolve } from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { apiEnvSchema } from '@whauto/config';
import { LoggerModule } from 'nestjs-pino';

import { DomainErrorFilter } from './common/filters/domain-error.filter';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { CartsModule } from './modules/carts/carts.module';
import { OrdersModule } from './modules/orders/orders.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { ContactsModule } from './modules/contacts/contacts.module';
import { DevWhatsAppMockModule } from './modules/dev-whatsapp-mock/dev-whatsapp-mock.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { WalletModule } from './wallet/wallet.module';
import { AiModule } from './modules/ai/ai.module';
import { ProductsModule } from './modules/products/products.module';
import { ShopsModule } from './modules/shops/shops.module';
import { WhatsAppChannelsModule } from './modules/whatsapp-channels/whatsapp-channels.module';
import { WhatsAppInboundModule } from './modules/whatsapp-inbound/whatsapp-inbound.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // `nest start` exécute avec cwd = apps/api : on cherche d'abord un .env local,
      // puis on retombe sur le .env à la racine du monorepo.
      envFilePath: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')],
      validate: (raw: Record<string, string | undefined>) => apiEnvSchema.parse(raw),
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
    PrismaModule,
    HealthModule,
    RealtimeModule,
    AuthModule,
    OrganizationsModule,
    WalletModule,
    ShopsModule,
    WhatsAppChannelsModule,
    WhatsAppInboundModule,
    WebhooksModule,
    ContactsModule,
    ConversationsModule,
    CategoriesModule,
    ProductsModule,
    InventoryModule,
    CartsModule,
    OrdersModule,
    AiModule,
    // Routes de simulation dev/test : module PHYSIQUEMENT absent sinon (404
    // naturel, aucune garde à contourner). Zod interdit true en production.
    // L'évaluation fonctionne car ConfigModule.forRoot() (plus haut dans ce
    // tableau) a déjà chargé les .env dans process.env via dotenv.
    ...(process.env.ENABLE_MOCK_WHATSAPP_ENDPOINTS === 'true' &&
    process.env.NODE_ENV !== 'production'
      ? [DevWhatsAppMockModule]
      : []),
  ],
  providers: [{ provide: APP_FILTER, useClass: DomainErrorFilter }],
})
export class AppModule {}
