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

  it('hands back a link that carries its own authority, not just an identifier', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const url = new URL(res.body.url);
    expect(url.pathname).toBe(`/sep24/interactive/${res.body.id}`);
    expect(url.searchParams.get('token')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
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

  it('does not refuse a wallet for sending a SEP-9 field the spec says it may send', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await http()
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        asset_code: 'USDC',
        birth_date: '1990-01-01',
        address: 'Jalan Merdeka 1',
        bank_number: '1234567890',
        source_asset: 'iso4217:IDR',
        wallet_name: 'Some Wallet',
      })
      .expect(200);
  });

  it('keeps nothing it was not asked for, even while accepting it', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC', bank_number: '1234567890' })
      .expect(200);
    const row = await prisma.sep24Transaction.findUnique({ where: { id: res.body.id } });
    expect(JSON.stringify(row)).not.toContain('1234567890');
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

  it('reads a multipart body, which the spec names as the encoding wallets should use', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .field('asset_code', 'USDC')
      .field('account', kp.publicKey())
      .expect(200);
    expect(res.body.type).toBe('interactive_customer_info_needed');
  });

  it('refuses a bracketed field name on the route itself, before the parser walks it', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await http()
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .field('asset_code', 'USDC')
      .field('items[0]', 'x')
      .expect(400);
  });

  it('refuses a body of parts carrying no disposition, which bound neither the field nor the file count', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await http()
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send(
        '--x\r\nContent-Disposition: form-data; name="asset_code"\r\n\r\nUSDC\r\n' +
          '--x\r\nA: B\r\n\r\n\r\n'.repeat(2_000) +
          '--x--\r\n',
      )
      .expect(400);
  });

  it('still refuses a multipart body that names an asset it does not serve', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await http()
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .field('asset_code', 'NOT_SUPPORTED')
      .expect(400);
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

describe('the account a deposit credits is the one its token speaks for', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootAuthApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('refuses to open a deposit that names somebody else s account', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const stranger = Keypair.random().publicKey();
    const res = await request(app.getHttpServer())
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC', account: stranger })
      .expect(400);
    expect(String(res.body.message ?? res.body.error)).toMatch(/token speaks for|another/i);
  });

  it('accepts the caller naming their own account, which is what a wallet does', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await request(app.getHttpServer())
      .post(PATH)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC', account: kp.publicKey() })
      .expect(200);
  });
});
