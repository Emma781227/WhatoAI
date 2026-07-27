import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { Redis } from 'ioredis';

@Injectable()
export class RedisHealthIndicator implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    configService: ConfigService,
  ) {
    this.client = new Redis(configService.get<string>('REDIS_URL')!, {
      maxRetriesPerRequest: 1,
      commandTimeout: 2000,
      lazyConnect: true,
    });
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      if (this.client.status !== 'ready') {
        await this.client.connect();
      }
      const pong = await this.client.ping();
      return pong === 'PONG' ? indicator.up() : indicator.down({ message: 'Unexpected ping response' });
    } catch (error) {
      return indicator.down({ message: (error as Error).message });
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
