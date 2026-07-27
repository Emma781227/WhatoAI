import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  // rawBody: true — conserve le corps brut (req.rawBody) pour la vérification
  // HMAC du webhook Meta, SANS casser le parsing JSON des autres endpoints
  // (additif — testé par un scénario de non-régression).
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });

  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  const configService = app.get(ConfigService);
  app.enableCors({
    origin: configService.get<string>('CORS_ORIGIN'),
    credentials: true,
  });

  // Socket.IO sur redis-adapter : le worker émet via redis-emitter, et
  // plusieurs instances d'API partageraient les mêmes rooms.
  const ioAdapter = new RedisIoAdapter(app, configService);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Whauto AI API')
    .setDescription('API du SaaS de commerce conversationnel WhatsApp')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = configService.get<number>('API_PORT') ?? 4000;
  await app.listen(port);
}

void bootstrap();
