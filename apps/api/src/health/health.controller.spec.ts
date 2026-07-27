import { Test } from '@nestjs/testing';
import { HealthCheckService, PrismaHealthIndicator } from '@nestjs/terminus';

import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './redis.health-indicator';

describe('HealthController', () => {
  it('agrège les indicateurs Prisma et Redis via HealthCheckService', async () => {
    const healthCheckService = { check: jest.fn().mockResolvedValue({ status: 'ok' }) };
    const prismaHealth = { pingCheck: jest.fn().mockResolvedValue({ database: { status: 'up' } }) };
    const redisIndicator = { isHealthy: jest.fn().mockResolvedValue({ redis: { status: 'up' } }) };

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: HealthCheckService, useValue: healthCheckService },
        { provide: PrismaHealthIndicator, useValue: prismaHealth },
        { provide: PrismaService, useValue: {} },
        { provide: RedisHealthIndicator, useValue: redisIndicator },
      ],
    }).compile();

    const controller = moduleRef.get(HealthController);
    const result = await controller.check();

    expect(result).toEqual({ status: 'ok' });
    expect(healthCheckService.check).toHaveBeenCalledWith(expect.any(Array));
  });
});
