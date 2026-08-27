import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AppModule } from '../app.module';
import { AccountSignersService } from '../sep10/account-signers.service';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

async function boot(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ThrottlerStorage)
    .useValue(noopStorage)
    .overrideProvider(AccountSignersService)
    .useValue({ load: jest.fn().mockResolvedValue(null) })
    .compile();
  const app = mod.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

async function sessionToken(app: INestApplication, kp: Keypair): Promise<string> {
  const ch = await request(app.getHttpServer())
    .post('/auth/challenge')
    .send({ address: kp.publicKey() })
    .expect(201);
  const payload = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf8'),
    Buffer.from(ch.body.nonce, 'utf8'),
  ]);
  const signature = Buffer.from(kp.sign(createHash('sha256').update(payload).digest())).toString(
    'base64',
  );
  const res = await request(app.getHttpServer())
    .post('/auth/verify')
    .send({ address: kp.publicKey(), nonce: ch.body.nonce, signature })
    .expect(201);
  return res.body.jwt as string;
}

async function anchorToken(app: INestApplication, kp: Keypair): Promise<string> {
  const ch = await request(app.getHttpServer())
    .get(`/auth?account=${kp.publicKey()}`)
    .expect(200);
  const tx = new Transaction(ch.body.transaction, Networks.TESTNET);
  tx.sign(kp);
  const res = await request(app.getHttpServer())
    .post('/auth')
    .send({ transaction: tx.toXdr() })
    .expect(200);
  return res.body.token as string;
}

describe('the token class is enforced by the running application, not only by its own unit test', () => {
  let app: INestApplication;
  let kp: Keypair;

  beforeAll(async () => {
    app = await boot();
    kp = Keypair.random();
  });

  afterAll(async () => {
    await app.close();
  });

  it('admits a session token to an ordinary user route', async () => {
    const jwt = await sessionToken(app, kp);
    await request(app.getHttpServer())
      .get('/profile')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
  });

  it('refuses an anchor token on that same route, for that same address', async () => {
    const jwt = await anchorToken(app, kp);
    await request(app.getHttpServer())
      .get('/profile')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(403);
  });

  it('refuses it on every route a provider or an administrator would use', async () => {
    const jwt = await anchorToken(app, kp);
    for (const path of ['/lp/me', '/lp/assignments', '/lp/earnings', '/orders', '/admin/orders']) {
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(403);
    }
  });
});
