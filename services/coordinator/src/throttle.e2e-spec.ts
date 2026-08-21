import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { AppModule } from './app.module';

describe('Rate limiting (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('bursting /auth/challenge beyond 10/min returns 429', async () => {
    const address = Keypair.random().publicKey();
    const server = app.getHttpServer();

    for (let i = 0; i < 10; i++) {
      await request(server)
        .post('/auth/challenge')
        .send({ address })
        .expect((res) => {
          if (res.status !== 201) {
            throw new Error(`Request ${i + 1} failed with status ${res.status}`);
          }
        });
    }

    const res = await request(server)
      .post('/auth/challenge')
      .send({ address });

    expect(res.status).toBe(429);
  });
});
