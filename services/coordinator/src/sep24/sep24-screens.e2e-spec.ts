import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { KYC_PROVIDER } from '../kyc/kyc-provider';
import { PrismaService } from '../prisma/prisma.service';


async function follow(app: INestApplication, id: string, token: string) {
  const hop = await request(app.getHttpServer())
    .get(`/sep24/interactive/${id}?token=${token}`)
    .expect(302);
  const setCookie = ([] as string[]).concat(hop.headers['set-cookie'] ?? []);
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return { cookie, page: () => request(app.getHttpServer()).get(`/sep24/interactive/${id}`).set('Cookie', cookie) };
}

describe('the popup a wallet opens, and what it will not do for a stranger', () => {
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

  async function opened() {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const url = new URL(res.body.url);
    return { kp, id: res.body.id, token: url.searchParams.get('token')!, jwt };
  }

  it('serves the identity form as html the browser is told not to keep', async () => {
    const { id, token } = await opened();
    const res = await (await follow(app, id, token)).page().expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<form');
    expect(res.text).toMatch(/first_name/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('carries no script, because a page with none cannot be told to run one', async () => {
    const { id, token } = await opened();
    const res = await (await follow(app, id, token)).page();
    expect(res.text).not.toMatch(/<script/i);
    expect(res.text).not.toMatch(/onclick=/i);
  });

  it('serves the interactive page under a referrer policy that keeps the Origin header on its own form posts, because a no-referrer page makes the browser send Origin: null and the anchor then refuses its own form', async () => {
    const { id, token } = await opened();
    const res = await (await follow(app, id, token)).page().expect(200);
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });

  it('refuses a link with no token', async () => {
    const { id } = await opened();
    await http().get(`/sep24/interactive/${id}`).expect(401);
  });

  it('refuses a token minted for a different transaction', async () => {
    const a = await opened();
    const b = await opened();
    await http().get(`/sep24/interactive/${a.id}?token=${b.token}`).expect(401);
  });

  it('refuses a transaction that does not exist, even with a well-formed token', async () => {
    const { token } = await opened();
    await http()
      .get(`/sep24/interactive/7a1f0c9e-0000-4000-8000-0000000000ff?token=${token}`)
      .expect(401);
  });

  it('will not take an amount from a caller whose identity was never screened', async () => {
    const { id, token } = await opened();
    const { cookie } = await follow(app, id, token);
    await http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .send({ fiat_amount: '400000' })
      .expect(403);
  });

  it('tells a refused identity so, and offers it nothing', async () => {
    const { id, token, kp } = await opened();
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: kp.publicKey() } });
    await prisma.kycVerification.create({
      data: {
        customerRef: kp.publicKey(),
        personId: link!.personId,
        status: 'REJECTED',
        rejectionReason: 'sanctions or watchlist match',
      },
    });
    const res = await (await follow(app, id, token)).page().expect(200);
    expect(res.text).toMatch(/refused/i);
    expect(res.text).not.toContain('<form');
  });

  it('asks for an amount once a screening has actually happened', async () => {
    const { id, token, kp } = await opened();
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: kp.publicKey() } });
    await prisma.kycVerification.create({
      data: {
        customerRef: kp.publicKey(),
        personId: link!.personId,
        status: 'ACCEPTED',
        screenedAt: new Date(),
      },
    });
    const res = await (await follow(app, id, token)).page().expect(200);
    expect(res.text).toMatch(/fiat_amount/);
  });

  it('waits rather than asking, while identity passed but screening has not', async () => {
    const { id, token, kp } = await opened();
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: kp.publicKey() } });
    await prisma.kycVerification.create({
      data: { customerRef: kp.publicKey(), personId: link!.personId, status: 'ACCEPTED' },
    });
    const res = await (await follow(app, id, token)).page().expect(200);
    expect(res.text).toContain('http-equiv="refresh"');
    expect(res.text).not.toMatch(/fiat_amount/);
  });
});

describe('the popup and the money gate must agree, or one of them is lying', () => {
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

  async function twoWalletsOnePerson() {
    const a = Keypair.random();
    const b = Keypair.random();
    const jwtA = await anchorToken(app, a);
    const jwtB = await anchorToken(app, b);
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: a.publicKey() } });
    await prisma.walletLink.update({
      where: { stellarAddress: b.publicKey() },
      data: { personId: link!.personId },
    });
    return { a, b, jwtA, jwtB, personId: link!.personId };
  }

  async function openFrom(jwt: string) {
    const res = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    return { id: res.body.id, token: new URL(res.body.url).searchParams.get('token')! };
  }

  it('shows the identity form to a wallet whose person is verified elsewhere, and says so in the json too', async () => {
    const { a, b, jwtB, personId } = await twoWalletsOnePerson();
    await prisma.kycVerification.create({
      data: { customerRef: a.publicKey(), personId, status: 'ACCEPTED', screenedAt: new Date() },
    });
    const { id, token } = await openFrom(jwtB);

    const json = await http()
      .get('/sep24/transactions?asset_code=USDC')
      .set('Authorization', `Bearer ${jwtB}`)
      .expect(200);
    const screen = await (await follow(app, id, token)).page().expect(200);

    const jsonSaysVerified = json.body.transactions[0].kyc_verified;
    const screenAsksForIdentity = /first_name/.test(screen.text);
    expect(jsonSaysVerified).toBe(!screenAsksForIdentity);
  });

  it('never offers an amount to a person refused under any of their wallets', async () => {
    const { a, b, jwtB, personId } = await twoWalletsOnePerson();
    await prisma.kycVerification.create({
      data: { customerRef: b.publicKey(), personId, status: 'ACCEPTED', screenedAt: new Date() },
    });
    await prisma.kycVerification.create({
      data: {
        customerRef: a.publicKey(),
        personId,
        status: 'REJECTED',
        rejectionReason: 'sanctions or watchlist match',
      },
    });
    const { id, token } = await openFrom(jwtB);
    const res = await (await follow(app, id, token)).page().expect(200);
    expect(res.text).not.toMatch(/fiat_amount/);
    expect(res.text).toMatch(/refused/i);
  });

  it('refuses to take an amount from a person refused elsewhere, before spending anything', async () => {
    const { a, b, jwtB, personId } = await twoWalletsOnePerson();
    await prisma.kycVerification.create({
      data: { customerRef: b.publicKey(), personId, status: 'ACCEPTED', screenedAt: new Date() },
    });
    await prisma.kycVerification.create({
      data: { customerRef: a.publicKey(), personId, status: 'REJECTED', rejectionReason: 'no' },
    });
    const { id, token } = await openFrom(jwtB);
    const { cookie } = await follow(app, id, token);
    await http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .send({ fiat_amount: '400000' })
      .expect(403);
  });
});

describe('a refusal inside the popup is a page, not a json blob', () => {
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

  async function opened(screened = false) {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    if (screened) {
      const link = await prisma.walletLink.findUnique({
        where: { stellarAddress: kp.publicKey() },
      });
      await prisma.kycVerification.create({
        data: {
          customerRef: kp.publicKey(),
          personId: link!.personId,
          status: 'ACCEPTED',
          screenedAt: new Date(),
        },
      });
    }
    const res = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    return { id: res.body.id, token: new URL(res.body.url).searchParams.get('token')! };
  }

  it('renders an unreadable amount as html a depositor can act on', async () => {
    const { id, token } = await opened(true);
    const { cookie } = await follow(app, id, token);
    const res = await http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .send({ fiat_amount: 'abc' });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).not.toMatch(/statusCode/);
    expect(res.text).toMatch(/plain digits/);
    expect(res.text).toMatch(/200\.000/);
  });

  it('offers a way back into the flow rather than ending it', async () => {
    const { id, token } = await opened(true);
    const { cookie } = await follow(app, id, token);
    const res = await http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .send({ fiat_amount: 'abc' });
    expect(res.text).toContain(`/sep24/interactive/${id}`);
  });

  it('renders a wrong-step refusal as a page too', async () => {
    const { id, token } = await opened();
    const { cookie } = await follow(app, id, token);
    const res = await http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .send({ fiat_amount: '400000' });
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).not.toMatch(/statusCode/);
  });

  it('escapes whatever the refusal says, because some of it comes from a vendor', async () => {
    const { id, token } = await opened(true);
    const { cookie } = await follow(app, id, token);
    const res = await http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .send({ fiat_amount: 'abc' });
    expect(res.text).not.toMatch(/<script/i);
  });

  it('still refuses a bad token as a page, not a json blob', async () => {
    const { id } = await opened();
    const res = await http().get(`/sep24/interactive/${id}?token=rubbish`);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

describe('handing the depositor to the vendor, and finding the way back', () => {
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

  it('sends the browser back to its own page after the identity form, never to the vendor origin', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const opened = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const id = opened.body.id;
    const token = new URL(opened.body.url).searchParams.get('token')!;

    const { cookie } = await follow(app, id, token);
    const res = await http()
      .post(`/sep24/interactive/${id}/identity`)
      .set('Cookie', cookie)
      .type('form')
      .send({
        first_name: 'Budi',
        last_name: 'Santoso',
        email_address: 'budi@example.com',
        id_type: 'id_card',
        id_country_code: 'IDN',
      });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/sep24/interactive/${id}`);
  });

  it('shows a way back to verification while waiting, so a closed tab is not a dead end', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const link = await prisma.walletLink.findUnique({
      where: { stellarAddress: kp.publicKey() },
    });
    await prisma.kycVerification.create({
      data: {
        customerRef: kp.publicKey(),
        personId: link!.personId,
        status: 'PROCESSING',
        providerRef: 'sess-waiting',
        verificationUrl: 'https://verify.didit.me/session/abc123',
      },
    });
    const opened = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const id = opened.body.id;
    const token = new URL(opened.body.url).searchParams.get('token')!;

    const res = await (await follow(app, id, token)).page().expect(200);
    expect(res.text).toContain('https://verify.didit.me/session/abc123');
    expect(res.text).toContain('http-equiv="refresh"');
  });

  it('asks for identity again when the session it was waiting on is older than a day, so a dead vendor link is not the end of the deposit', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const link = await prisma.walletLink.findUnique({
      where: { stellarAddress: kp.publicKey() },
    });
    await prisma.kycVerification.create({
      data: {
        customerRef: kp.publicKey(),
        personId: link!.personId,
        status: 'PROCESSING',
        providerRef: 'sess-stale',
        verificationUrl: 'https://verify.didit.me/session/stale',
      },
    });
    await prisma.kycVerification.update({
      where: { customerRef: kp.publicKey() },
      data: { updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });
    const opened = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const id = opened.body.id;
    const token = new URL(opened.body.url).searchParams.get('token')!;

    const session = await follow(app, id, token);
    const res = await session.page().expect(200);
    expect(res.text).toContain('name="first_name"');
    expect(res.text).not.toContain('https://verify.didit.me/session/stale');

    await http()
      .post(`/sep24/interactive/${id}/identity`)
      .set('Cookie', session.cookie)
      .type('form')
      .send({ first_name: 'Budi', last_name: 'Santoso', email_address: 'budi@example.com', id_type: 'id_card', id_country_code: 'IDN' })
      .expect(302);
    const row = await prisma.kycVerification.findUniqueOrThrow({ where: { customerRef: kp.publicKey() } });
    expect(row.providerRef).not.toBe('sess-stale');
  });
});

describe('the screen that actually asks for money', () => {
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

  async function fundedDeposit(paymentDetails: string) {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const link = await prisma.walletLink.findUnique({
      where: { stellarAddress: kp.publicKey() },
    });
    await prisma.kycVerification.create({
      data: {
        customerRef: kp.publicKey(),
        personId: link!.personId,
        status: 'ACCEPTED',
        screenedAt: new Date(),
      },
    });
    const opened = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const id = opened.body.id;
    const token = new URL(opened.body.url).searchParams.get('token')!;

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const order = await prisma.order.create({
      data: {
        tradeId: `t-${id}`.slice(0, 64),
        userAddress: kp.publicKey(),
        personId: link!.personId,
        flow: 'TOP_UP',
        rail: 'BANK',
        usdcAmount: 25_0000000n,
        fiatAmount: 4_000_000n,
        rateSnapshot: '16000',
        platformFeeBps: 30,
        lpFeeBps: 120,
        platformWallet: 'GPLATFORM',
        status: 'FUNDED',
        payDeadline: deadline,
        confirmDeadline: deadline,
        disputeDeadline: deadline,
        expiresAt: new Date(Date.now() + 1_800_000),
        lpPaymentDetails: paymentDetails,
        ref: `LP-REF-${id.slice(0, 8)}`,
      },
    });
    await prisma.sep24Transaction.update({ where: { id }, data: { orderId: order.id } });
    return { id, token };
  }

  it('shows the amount, the provider details, the reference and the deadline', async () => {
    const { id, token } = await fundedDeposit('BCA 1234567890 a/n Budi');
    const res = await (await follow(app, id, token)).page().expect(200);
    expect(res.text).toContain('BCA 1234567890 a/n Budi');
    expect(res.text).toContain(`LP-REF-${id.slice(0, 8)}`);
    expect(res.text).toContain('4.000.000');
    expect(res.text).toMatch(/before 20\d\d-/);
  });

  it('escapes provider details, which are free text somebody else controls', async () => {
    const { id, token } = await fundedDeposit('<script>alert(1)</script>');
    const res = await (await follow(app, id, token)).page().expect(200);
    expect(res.text).not.toMatch(/<script>alert/);
    expect(res.text).toContain('&lt;script&gt;');
  });

  it('keeps refreshing, because the escrow settles while the page is open', async () => {
    const { id, token } = await fundedDeposit('BCA 1');
    const res = await (await follow(app, id, token)).page();
    expect(res.text).toContain('http-equiv="refresh"');
  });
});

describe('the write credential stays out of every log a URL lands in', () => {
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
    return {
      id: res.body.id,
      token: new URL(res.body.url).searchParams.get('token')!,
      account: kp.publicKey(),
    };
  }

  it('takes the token out of the address bar on arrival', async () => {
    const { id, token } = await opened();
    const hop = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(302);
    expect(hop.headers.location).toBe(`/sep24/interactive/${id}`);
    expect(hop.headers.location).not.toContain('token');
  });

  it('hands it over in a cookie no script can read and no cross-site post can carry', async () => {
    const { id, token } = await opened();
    const hop = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(302);
    const set = ([] as string[]).concat(hop.headers['set-cookie'] ?? []).join('|');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Secure');
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toContain(`Path=/sep24/interactive/${id}`);
  });

  it('refuses a write that arrives from somebody else s page', async () => {
    const { id, token } = await opened();
    const { cookie } = await follow(app, id, token);
    await http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send({ fiat_amount: '400000' })
      .expect(403);
  });

  it('refuses an identity submission that arrives from somebody else s page', async () => {
    const { id, token } = await opened();
    const { cookie } = await follow(app, id, token);
    await http()
      .post(`/sep24/interactive/${id}/identity`)
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send({ first_name: 'Budi', last_name: 'Santoso', email_address: 'budi@example.com' })
      .expect(403);
  });

  it('admits a write from this anchor s own page, so a wrong base url cannot lock every browser out', async () => {
    const { id, token } = await opened();
    const { cookie } = await follow(app, id, token);
    const res = await http()
      .post(`/sep24/interactive/${id}/identity`)
      .set('Cookie', cookie)
      .set('Origin', 'https://api.lolipay.app')
      .send({ first_name: 'Budi', last_name: 'Santoso', email_address: 'budi@example.com' });
    expect(res.status).not.toBe(403);
  });

  it('names the wallet the deposit will credit, so a lured depositor sees an address that is not theirs', async () => {
    const { id, token, account } = await opened();
    const res = await (await follow(app, id, token)).page().expect(200);
    expect(res.text).toContain(account);
  });

  it('never puts the credential back into the page it serves', async () => {
    const { id, token } = await opened();
    const { page } = await follow(app, id, token);
    const res = await page().expect(200);
    expect(res.text).not.toContain(token);
    expect(res.text).not.toContain('name="token"');
  });

  it('refuses a write carrying only a token in the query string, which is what a log leak gives an attacker', async () => {
    const { id, token } = await opened();
    await http()
      .post(`/sep24/interactive/${id}/amount?token=${token}`)
      .send({ fiat_amount: '400000' })
      .expect(401);
  });

  it('serves the page from the cookie alone, with no token anywhere in the request', async () => {
    const { id, token } = await opened();
    const { page } = await follow(app, id, token);
    const res = await page().expect(200);
    expect(res.text).toContain('<form');
  });

  it('refuses the bare page to a browser holding no cookie', async () => {
    const { id } = await opened();
    await http().get(`/sep24/interactive/${id}`).expect(401);
  });
});

describe('the identity form says what to type, and names the partner that checks it', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootAuthApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('offers the document types as a list, fills the country with IDN, asks for the email as an email, and says Didit is next', async () => {
    const jwt = await anchorToken(app, Keypair.random());
    const res0 = await request(app.getHttpServer())
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const id = res0.body.id;
    const token = new URL(res0.body.url).searchParams.get('token')!;
    const res = await (await follow(app, id, token)).page().expect(200);
    expect(res.text).toContain('<select id="id_type" name="id_type">');
    expect(res.text).toContain('value="IDN"');
    expect(res.text).toContain('type="email"');
    expect(res.text).toContain(
      'Next, our verification partner Didit checks your document — have your KTP or passport ready and your phone nearby.',
    );
  });
});

describe('after the identity form, the popup lands on the screen that keeps checking', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootAuthApp((b) =>
      b.overrideProvider(KYC_PROVIDER).useValue({
        start: async () => ({
          status: 'PROCESSING',
          providerRef: 'fake-session',
          verificationUrl: 'https://verify.example/session/abc123',
        }),
      }),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('hands the user to the waiting screen, which offers the vendor link and refreshes on its own', async () => {
    prisma = app.get(PrismaService);
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const opened = await request(app.getHttpServer())
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const id = opened.body.id;
    const token = new URL(opened.body.url).searchParams.get('token')!;
    const { cookie, page } = await follow(app, id, token);

    const posted = await request(app.getHttpServer())
      .post(`/sep24/interactive/${id}/identity`)
      .set('Cookie', cookie)
      .type('form')
      .send({
        first_name: 'Budi',
        last_name: 'Santoso',
        email_address: 'budi@example.com',
        id_type: 'id_card',
        id_country_code: 'IDN',
      })
      .expect(302);
    expect(posted.headers.location).toBe(`/sep24/interactive/${id}`);

    const shown = await page().expect(200);
    expect(shown.text).toContain('https://verify.example/session/abc123');
    expect(shown.text).toContain('class="btn"');
    expect(shown.text).toContain('Verify your identity with Didit');
    expect(shown.text).toContain('Open Didit verification');
    expect(shown.text).toContain('http-equiv="refresh" content="10"');

    await prisma.kycVerification.update({ where: { customerRef: kp.publicKey() }, data: { deliveredAt: new Date() } });
    const delivered = await page().expect(200);
    expect(delivered.text).toContain('Checking your identity');
    expect(delivered.text).toContain('https://verify.example/session/abc123');
    expect(delivered.text).not.toContain('Open Didit verification');

    await prisma.kycVerification.update({
      where: { customerRef: kp.publicKey() },
      data: { status: 'ACCEPTED', deliveredAt: null, screenedAt: null },
    });
    const accepted = await page().expect(200);
    expect(accepted.text).toContain('Checking your identity');
    expect(accepted.text).toContain('https://verify.example/session/abc123');
    expect(accepted.text).not.toContain('Open Didit verification');

    await prisma.kycVerification.update({
      where: { customerRef: kp.publicKey() },
      data: { status: 'PROCESSING', verificationUrl: 'http://verify.example/plain' },
    });
    const plain = await page().expect(200);
    expect(plain.text).toContain('Checking your identity');
    expect(plain.text).not.toContain('class="btn"');
    expect(plain.text).not.toContain('href="http://');
  });
});
