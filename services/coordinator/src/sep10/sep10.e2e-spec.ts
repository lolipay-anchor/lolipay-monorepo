import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AppModule } from '../app.module';
import { AccountSignersService } from './account-signers.service';
import { Sep10Service } from './sep10.service';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

describe('SEP-10 over HTTP', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .overrideProvider(AccountSignersService)
      .useValue({ load: async () => null })
      .compile();
    app = mod.createNestApplication();
    app.use(require('express').json({ limit: '100kb' }));
    app.use(require('express').urlencoded({ extended: false, limit: '100kb' }));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is configured, so nothing below is passing vacuously', () => {
    expect(app.get(Sep10Service).isConfigured).toBe(true);
  });

  it('refuses a challenge request with no account', async () => {
    await request(app.getHttpServer()).get('/auth').expect(400);
  });

  it('refuses a challenge request with a malformed account', async () => {
    await request(app.getHttpServer()).get('/auth?account=invalid-account').expect(400);
  });

  it('refuses a token request with no transaction', async () => {
    await request(app.getHttpServer()).post('/auth').send({}).expect(400);
  });

  it('accepts a form-encoded body, which is what the suite posts by default', async () => {
    const kp = Keypair.random();
    const ch = await request(app.getHttpServer())
      .get(`/auth?account=${kp.publicKey()}`)
      .expect(200);
    const tx = new Transaction(ch.body.transaction, Networks.TESTNET);
    tx.sign(kp);

    const res = await request(app.getHttpServer())
      .post('/auth')
      .type('form')
      .send({ transaction: tx.toXdr() })
      .expect(200);

    expect(typeof res.body.token).toBe('string');
  });

  it('accepts a json body too', async () => {
    const kp = Keypair.random();
    const ch = await request(app.getHttpServer())
      .get(`/auth?account=${kp.publicKey()}`)
      .expect(200);
    const tx = new Transaction(ch.body.transaction, Networks.TESTNET);
    tx.sign(kp);

    const res = await request(app.getHttpServer())
      .post('/auth')
      .send({ transaction: tx.toXdr() })
      .expect(200);

    expect(typeof res.body.token).toBe('string');
  });

  it('refuses the same signed challenge twice', async () => {
    const kp = Keypair.random();
    const ch = await request(app.getHttpServer())
      .get(`/auth?account=${kp.publicKey()}`)
      .expect(200);
    const tx = new Transaction(ch.body.transaction, Networks.TESTNET);
    tx.sign(kp);
    const body = { transaction: tx.toXdr() };

    await request(app.getHttpServer()).post('/auth').type('form').send(body).expect(200);
    await request(app.getHttpServer()).post('/auth').type('form').send(body).expect(400);
  });

  it('mints a token the internal API refuses', async () => {
    const kp = Keypair.random();
    const ch = await request(app.getHttpServer())
      .get(`/auth?account=${kp.publicKey()}`)
      .expect(200);
    const tx = new Transaction(ch.body.transaction, Networks.TESTNET);
    tx.sign(kp);
    const res = await request(app.getHttpServer())
      .post('/auth')
      .type('form')
      .send({ transaction: tx.toXdr() })
      .expect(200);

    await request(app.getHttpServer())
      .get('/profile')
      .set('Authorization', `Bearer ${res.body.token}`)
      .expect(403);
  });
});
