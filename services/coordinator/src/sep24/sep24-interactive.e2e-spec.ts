import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';

const PATH = '/sep24/transactions/deposit/interactive';

describe('opening a deposit from a wallet that has never met this anchor', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('refuses with 403 and not 401 when no token is presented', async () => {
    await http().post(PATH).send({ asset_code: 'USDC' }).expect(403);
  });

  it('opens for an account that has never done KYC, because the gate lives in the screens', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC', account: kp.publicKey() })
      .expect(200);
    expect(res.body).toEqual({
      type: 'interactive_customer_info_needed',
      url: expect.stringMatching(/^https:\/\//),
      id: expect.any(String),
    });
  });

  it('returns exactly three keys, because the schema forbids any other', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' });
    expect(Object.keys(res.body).sort()).toEqual(['id', 'type', 'url']);
  });

  it('opens a distinct transaction every time, because the suite posts three and counts them', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const res = await http()
        .post(PATH)
        .set('Authorization', `Bearer ${jwt}`)
        .send({ asset_code: 'USDC' })
        .expect(200);
      ids.add(res.body.id);
    }
    expect(ids.size).toBe(3);
    const listed = await http()
      .get('/sep24/transactions?asset_code=USDC')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    expect(listed.body.transactions.length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['no asset_code at all', {}],
    ['an asset it does not serve', { asset_code: 'NOT_SUPPORTED' }],
    ['an account that is not an address', { asset_code: 'USDC', account: 'not a valid account' }],
  ])('refuses %s with 400 and a readable error', async (_name, body) => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http().post(PATH).set('Authorization', `Bearer ${jwt}`).send(body).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toHaveProperty('error');
  });

  it('accepts every field a real wallet sends, not only the two the suite happens to post', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await http()
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        asset_code: 'USDC',
        asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        account: kp.publicKey(),
        amount: '25',
        memo: '1',
        memo_type: 'id',
        lang: 'en',
        claimable_balance_supported: 'false',
        customer_id: 'abc',
        email_address: 'someone@example.com',
      })
      .expect(200);
  });

  it('reads a form-encoded body, which is what the spec tells wallets they may send', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await http()
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .type('form')
      .send({ asset_code: 'USDC' })
      .expect(200);
  });

  it('records the transaction against the person the token speaks for', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const row = await prisma.sep24Transaction.findUnique({ where: { id: res.body.id } });
    expect(row?.stellarAccount).toBe(kp.publicKey());
    expect(row?.personId).toBeTruthy();
  });
});
