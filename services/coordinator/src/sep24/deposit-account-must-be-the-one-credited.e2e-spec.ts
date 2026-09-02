import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Account, Keypair, MuxedAccount } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';

describe('the account a deposit names must be the account the escrow will credit', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootAuthApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const open = (jwt: string, account?: string) =>
    request(app.getHttpServer())
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send(account === undefined ? { asset_code: 'USDC' } : { asset_code: 'USDC', account });

  it('accepts the bare account a bare token speaks for', async () => {
    const kp = Keypair.random();
    await open(await anchorToken(app, kp), kp.publicKey()).expect(200);
  });

  it('accepts a sibling memo of the same account, which settles to the same place', async () => {
    const kp = Keypair.random();
    await open(await anchorToken(app, kp, 1), `${kp.publicKey()}:2`).expect(200);
  });

  it('accepts the base account a muxed token speaks for, because that is where the escrow credits', async () => {
    const kp = Keypair.random();
    const muxed = new MuxedAccount(new Account(kp.publicKey(), '0'), '9').accountId();
    const jwt = await anchorToken(app, kp);
    const res = await open(jwt, muxed);
    expect(res.status).toBe(200);
  });

  it('still refuses an account the escrow would never credit', async () => {
    const kp = Keypair.random();
    const stranger = Keypair.random().publicKey();
    const res = await open(await anchorToken(app, kp), stranger);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/will not deposit to another/);
  });
});
