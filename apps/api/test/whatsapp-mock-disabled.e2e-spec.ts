// ENABLE_MOCK_WHATSAPP_ENDPOINTS=false AVANT l'import d'AppModule : le module
// DevWhatsAppMockModule n'est alors PAS enregistré — les routes n'existent
// physiquement pas (404), il n'y a aucune garde à contourner. Jest isole le
// registre de modules par fichier de test : ce fichier voit sa propre
// évaluation d'AppModule, indépendante de whatsapp.e2e-spec.ts.
process.env.NODE_ENV = 'development';
process.env.LOG_LEVEL = 'fatal';
process.env.REDIS_URL = 'redis://localhost:6379/1';
process.env.ENABLE_MOCK_WHATSAPP_ENDPOINTS = 'false';

import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { AppModule } from '../src/app.module';

describe('Endpoints mock désactivés (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  }, 60000);

  afterAll(async () => {
    await app?.close();
  });

  it('POST /api/dev/whatsapp/mock/inbound est physiquement absent (404)', async () => {
    await request(app.getHttpServer())
      .post('/api/dev/whatsapp/mock/inbound')
      .send({ channelId: 'x', phone: '+237650000000', text: 'test' })
      .expect(404);
  });

  it('POST /api/dev/whatsapp/mock/status est physiquement absent (404)', async () => {
    await request(app.getHttpServer())
      .post('/api/dev/whatsapp/mock/status')
      .send({ channelId: 'x', externalMessageId: 'y', status: 'DELIVERED' })
      .expect(404);
  });
});
