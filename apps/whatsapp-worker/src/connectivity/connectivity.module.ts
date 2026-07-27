import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import { ConnectivityService } from './connectivity.service';
import { REDIS_CLIENT } from './redis-client.token';

@Module({
  providers: [
    ConnectivityService,
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        new Redis(configService.get<string>('REDIS_URL')!, {
          maxRetriesPerRequest: 1,
          commandTimeout: 2000,
        }),
    },
  ],
})
export class ConnectivityModule {}
