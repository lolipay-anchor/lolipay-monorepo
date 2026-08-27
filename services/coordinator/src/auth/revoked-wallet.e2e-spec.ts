import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { bootAuthApp } from './auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';

async function verifyWith(app: INestApplication, kp: Keypair) {
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
  return request(app.getHttpServer())
    .post('/auth/verify')
    .send({ address: kp.publicKey(), nonce: ch.body.nonce, signature });
}

describe('a wallet that has been revoked cannot authenticate at either door', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a revoked wallet at the peer-to-peer door, however good its signature is', async () => {
    const kp = Keypair.random();
    await verifyWith(app, kp).then((r) => expect(r.status).toBe(201));

    await prisma.walletLink.update({
      where: { stellarAddress: kp.publicKey() },
      data: { status: 'REVOKED' },
    });

    const again = await verifyWith(app, kp);
    expect(again.status).toBe(401);
  });

  it('refuses it at the anchor door as well', async () => {
    const kp = Keypair.random();
    const ch = await request(app.getHttpServer())
      .get(`/auth?account=${kp.publicKey()}`)
      .expect(200);
    expect(ch.body.transaction).toBeDefined();
    await verifyWith(app, kp).then((r) => expect(r.status).toBe(201));

    await prisma.walletLink.update({
      where: { stellarAddress: kp.publicKey() },
      data: { status: 'REVOKED' },
    });

    const { Transaction, Networks } = await import('@stellar/stellar-sdk');
    const fresh = await request(app.getHttpServer())
      .get(`/auth?account=${kp.publicKey()}`)
      .expect(200);
    const tx = new Transaction(fresh.body.transaction, Networks.TESTNET);
    tx.sign(kp);
    const res = await request(app.getHttpServer())
      .post('/auth')
      .send({ transaction: tx.toXdr() });
    expect(res.status).toBe(401);
  });
});
