import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { ConnectivityService } from './connectivity.service';
import { REDIS_CLIENT } from './redis-client.token';

describe('ConnectivityService', () => {
  it('journalise une connectivité saine quand les deux pings réussissent', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { ping: jest.fn().mockResolvedValue('PONG') };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConnectivityService,
        { provide: PrismaService, useValue: prisma },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    const service = moduleRef.get(ConnectivityService);
    await expect(service.checkConnectivity()).resolves.toBeUndefined();
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(redis.ping).toHaveBeenCalled();
  });

  it("ne lève pas d'exception si Redis est injoignable", async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const redis = { ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConnectivityService,
        { provide: PrismaService, useValue: prisma },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    const service = moduleRef.get(ConnectivityService);
    await expect(service.checkConnectivity()).resolves.toBeUndefined();
  });
});
