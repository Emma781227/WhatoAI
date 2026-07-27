import type { INestApplicationContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Adapter Socket.IO branché sur Redis : indispensable pour que le worker
 * (redis-emitter) puisse émettre vers les clients connectés à l'API, et déjà
 * prêt pour plusieurs instances d'API. CORS aligné sur l'API HTTP.
 */
export class RedisIoAdapter extends IoAdapter {
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(
    app: INestApplicationContext,
    private readonly configService: ConfigService,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const url = this.configService.get<string>('REDIS_URL') as string;
    this.pubClient = new Redis(url, { maxRetriesPerRequest: null });
    this.subClient = this.pubClient.duplicate();
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: this.configService.get<string>('CORS_ORIGIN'),
        credentials: true,
      },
    }) as Server;

    if (this.pubClient && this.subClient) {
      server.adapter(createAdapter(this.pubClient, this.subClient));
    }
    return server;
  }

  /** Appelé par Nest à app.close() — libère aussi les clients Redis de l'adapter. */
  override async dispose(): Promise<void> {
    await super.dispose();
    this.pubClient?.disconnect();
    this.subClient?.disconnect();
  }
}
