import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AppModule } from '../app.module';
import { AccountSignersService } from '../sep10/account-signers.service';
import { configureHttp } from '../http-setup';
import { KYC_PROVIDER } from '../kyc/kyc-provider';
import { StubKycProvider } from '../kyc/stub-kyc-provider';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

export async function bootAuthApp(): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ThrottlerStorage)
    .useValue(noopStorage)
    .overrideProvider(AccountSignersService)
    .useValue({ load: jest.fn().mockResolvedValue(null) })
    .overrideProvider(KYC_PROVIDER)
    .useValue(new StubKycProvider())
    .compile();
  const app = mod.createNestApplication();
  configureHttp(app);
  await app.init();
  return app;
}

export async function sessionToken(app: INestApplication, kp: Keypair): Promise<string> {
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

export async function anchorToken(
  app: INestApplication,
  kp: Keypair,
  memo?: string | number,
): Promise<string> {
  const query = memo === undefined ? '' : `&memo=${memo}`;
  const ch = await request(app.getHttpServer())
    .get(`/auth?account=${kp.publicKey()}${query}`)
    .expect(200);
  const tx = new Transaction(ch.body.transaction, Networks.TESTNET);
  tx.sign(kp);
  const res = await request(app.getHttpServer())
    .post('/auth')
    .send({ transaction: tx.toXdr() })
    .expect(200);
  return res.body.token as string;
}
