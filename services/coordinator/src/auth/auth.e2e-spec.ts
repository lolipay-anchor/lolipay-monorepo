import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { AppModule } from '../app.module';
import { ThrottlerStorage } from '@nestjs/throttler';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

function signChallenge(kp: Keypair, message: string): string {
  const payload = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf8'),
    Buffer.from(message, 'utf8'),
  ]);
  const hash = createHash('sha256').update(payload).digest();
  return kp.sign(hash).toString('base64');
}

describe('Auth', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it('challenge → sign → verify → jwt', async () => {
    const kp = Keypair.random();
    const ch = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ address: kp.publicKey() })
      .expect(201);
    const nonce = ch.body.nonce;
    expect(typeof nonce).toBe('string');
    const sig = signChallenge(kp, nonce);
    const res = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ address: kp.publicKey(), nonce, signature: sig })
      .expect(201);
    expect(typeof res.body.jwt).toBe('string');
  });

  it('rejects a bad signature', async () => {
    const kp = Keypair.random();
    const ch = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ address: kp.publicKey() })
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/verify')
      .send({
        address: kp.publicKey(),
        nonce: ch.body.nonce,
        signature: Buffer.from('bad').toString('base64'),
      })
      .expect(401);
  });

  it('replay: second verify with same nonce → 401 (nonce consumed)', async () => {
    const kp = Keypair.random();
    const ch = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ address: kp.publicKey() })
      .expect(201);
    const nonce = ch.body.nonce;
    const sig = signChallenge(kp, nonce);

    await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ address: kp.publicKey(), nonce, signature: sig })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ address: kp.publicKey(), nonce, signature: sig })
      .expect(401);
  });

  it('unknown/never-issued nonce → 401', async () => {
    const kp = Keypair.random();
    const fakeNonce = `lolipay-auth:${kp.publicKey()}:deadbeefdeadbeef`;
    const sig = signChallenge(kp, fakeNonce);
    await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ address: kp.publicKey(), nonce: fakeNonce, signature: sig })
      .expect(401);
  });
});
