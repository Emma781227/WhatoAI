import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Redis } from 'ioredis';

import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from './redis-client.token';

@Injectable()
export class ConnectivityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConnectivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.checkConnectivity();
  }

  @Interval(30000)
  async checkConnectivity(): Promise<void> {
    const [dbOk, redisOk] = await Promise.all([this.pingDatabase(), this.pingRedis()]);
    this.logger.log(
      `Connectivité — PostgreSQL: ${dbOk ? 'OK' : 'KO'}, Redis: ${redisOk ? 'OK' : 'KO'}`,
    );
  }

  private async pingDatabase(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async pingRedis(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
