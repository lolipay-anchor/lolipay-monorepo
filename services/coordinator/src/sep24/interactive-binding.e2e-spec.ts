import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { AppConfigService } from '../config/app-config.service';
import { mintInteractiveToken } from './interactive-token';

describe('a link is bound to the account it was issued for, not only to the transaction', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootAuthApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function opened() {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    return { id: res.body.id, account: kp.publicKey() };
  }

  it('refuses a token naming the right transaction and the wrong account', async () => {
    const { id, account } = await opened();
    const stranger = Keypair.random().publicKey();
    expect(stranger).not.toBe(account);
    const forged = mintInteractiveToken(app.get(AppConfigService), id, stranger);
    await http().get(`/sep24/interactive/${id}?token=${forged}`).expect(404);
  });

  it('admits the token naming the account the transaction belongs to', async () => {
    const { id, account } = await opened();
    const honest = mintInteractiveToken(app.get(AppConfigService), id, account);
    await http().get(`/sep24/interactive/${id}?token=${honest}`).expect(302);
  });
});
