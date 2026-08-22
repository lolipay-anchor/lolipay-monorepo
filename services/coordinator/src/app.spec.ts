import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';

class PrismaServiceStub {
  async onModuleInit() {  }
  async $connect() {  }
  async $disconnect() {  }
  market = {
    findUnique: async () => null,
    findMany: async () => [],
    upsert: async () => ({}),
    update: async () => ({}),
  };
  config = {
    findUnique: async () => null,
    update: async () => ({}),
    upsert: async ({ create }: any) => ({ id: 1, spreadBps: 150, ...create }),
  };
  order = {
    findMany: async () => [],
  };
  userProfile = {
    upsert: async () => ({}),
  };
}

describe('Health', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useClass(PrismaServiceStub)
      .compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  it('GET /health → ok', () =>
    request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' }));
});
