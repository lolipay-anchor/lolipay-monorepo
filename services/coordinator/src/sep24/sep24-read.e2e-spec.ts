import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';

describe('the SEP-24 surface a wallet reads before it ever deposits', () => {
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

  describe('the popup a wallet opens keeps its opener', () => {
    it('serves cross-origin-opener-policy unsafe-none on every route the popup navigates', async () => {
      const routes: Array<[string, () => request.Test]> = [
        ['GET interactive', () => http().get('/sep24/interactive/nope')],
        ['POST identity', () => http().post('/sep24/interactive/nope/identity').send({})],
        ['POST amount', () => http().post('/sep24/interactive/nope/amount').send({})],
      ];
      for (const [name, call] of routes) {
        const res = await call();
        expect([name, res.headers['cross-origin-opener-policy']]).toEqual([name, 'unsafe-none']);
      }
    });

    it('keeps the header on the error path, where a guard answers before the decorator runs', async () => {
      const res = await http().get('/sep24/interactive/nope');
      expect(res.status).toBe(401);
      expect(res.headers['cross-origin-opener-policy']).toBe('unsafe-none');
    });

    it('leaves the default same-origin policy in place everywhere else', async () => {
      const res = await http().get('/sep24/info');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    });
  });

  describe('the withdrawal door and what /info promises are one switch', () => {
    it('does not advertise withdrawal while the switch is off', async () => {
      const { body } = await http().get('/sep24/info');
      expect(body.withdraw.USDC.enabled).toBe(false);
    });

    it('refuses to open a withdrawal while the switch is off, rather than only hiding it from /info', async () => {
      const kp = Keypair.random();
      const jwt = await anchorToken(app, kp);
      const res = await http()
        .post('/sep24/transactions/withdraw/interactive')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ asset_code: 'USDC' })
        .expect(403);
      expect(res.body.message).toMatch(/does not offer withdrawal/i);
    });

    it('needs a SEP-10 token, so the door is not open to an unauthenticated caller', async () => {
      await http()
        .post('/sep24/transactions/withdraw/interactive')
        .send({ asset_code: 'USDC' })
        .expect(403);
    });
  });

  describe('the wallet signing probe, which no longer exists', () => {
    it.each(['/sep24/signing-probe', '/sep24/signing-probe.js'])(
      'answers 404 at %s, so no unauthenticated page drives the RPC any more',
      async (path) => {
        await http().get(path).expect(404);
      },
    );

    it('answers 404 at the xdr builder, which took a caller-supplied address', async () => {
      await http()
        .get('/sep24/signing-probe/xdr?address=GBS7GJRDNMLBYCHTPMHFHLLQMIQFCLYQTZ4WBHUYQPUHPQOWLLQZJIGN')
        .expect(404);
    });
  });

  describe('GET /sep24/info', () => {
    it('needs no token, because a wallet reads it before authenticating', async () => {
      const res = await http().get('/sep24/info').expect(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('carries deposit, withdraw and fee, all three required by the schema', async () => {
      const { body } = await http().get('/sep24/info');
      expect(body).toHaveProperty('deposit');
      expect(body).toHaveProperty('withdraw');
      expect(body).toHaveProperty('fee');
      expect(body.fee).toEqual({ enabled: false });
    });

    it('offers deposit and says plainly that withdrawal is not enabled', async () => {
      const { body } = await http().get('/sep24/info');
      expect(body.deposit.USDC.enabled).toBe(true);
      expect(body.withdraw.USDC.enabled).toBe(false);
    });

    it('says plainly that it cannot create accounts, or wallets assume it can', async () => {
      const { body } = await http().get('/sep24/info');
      expect(body.features.account_creation).toBe(false);
      expect(body.features.claimable_balances).toBe(false);
    });

    it('publishes the fee a wallet would otherwise have no way to learn', async () => {
      const { body } = await http().get('/sep24/info');
      expect(typeof body.deposit.USDC.fee_percent).toBe('number');
      expect(body.deposit.USDC.fee_percent).toBeGreaterThan(0);
    });

    it('states every numeric limit as a number, which the schema demands', async () => {
      const { body } = await http().get('/sep24/info');
      for (const [key, value] of Object.entries(body.deposit.USDC)) {
        if (key === 'enabled') continue;
        expect(typeof value).toBe('number');
      }
    });

    it('puts nothing in the per-asset object the schema forbids', async () => {
      const { body } = await http().get('/sep24/info');
      const allowed = ['enabled', 'fee_fixed', 'fee_minimum', 'fee_percent', 'min_amount', 'max_amount'];
      for (const key of Object.keys(body.deposit.USDC)) {
        expect(allowed).toContain(key);
      }
    });
  });

  describe('the endpoints that need a token refuse without one', () => {
    it.each(['/sep24/transactions?asset_code=USDC', '/sep24/transaction?id=x'])(
      'answers 403 on %s, not 401, which is what the suite asserts',
      async (path) => {
        await http().get(path).expect(403);
      },
    );
  });

  describe('GET /sep24/transactions', () => {
    it('answers an account it has never seen with an empty list, never a 404', async () => {
      const kp = Keypair.random();
      const jwt = await anchorToken(app, kp);
      const res = await http()
        .get('/sep24/transactions?asset_code=USDC')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(200);
      expect(res.body.transactions).toEqual([]);
    });

    it('rejects an asset it does not serve', async () => {
      const kp = Keypair.random();
      const jwt = await anchorToken(app, kp);
      await http()
        .get('/sep24/transactions?asset_code=BADCODE')
        .set('Authorization', `Bearer ${jwt}`)
        .expect(400);
    });
  });

  describe('GET /sep24/transaction', () => {
    it.each(['id', 'stellar_transaction_id', 'external_transaction_id'])(
      'answers 404 for an unknown %s rather than an empty body',
      async (param) => {
        const kp = Keypair.random();
        const jwt = await anchorToken(app, kp);
        await http()
          .get(`/sep24/transaction?${param}=does-not-exist`)
          .set('Authorization', `Bearer ${jwt}`)
          .expect(404);
      },
    );
  });

  describe('GET /sep24/more-info/:id', () => {
    it('is served as html with no token, because the suite fetches it cold', async () => {
      const kp = Keypair.random();
      const jwt = await anchorToken(app, kp);
      const person = await prisma.walletLink.findUnique({
        where: { stellarAddress: kp.publicKey() },
      });
      const tx = await prisma.sep24Transaction.create({
        data: { personId: person!.personId, stellarAccount: kp.publicKey(), assetCode: 'USDC' },
      });
      void jwt;
      const res = await http().get(`/sep24/more-info/${tx.id}`).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
    });

    it('answers 404 for a transaction that does not exist', async () => {
      await http().get('/sep24/more-info/7a1f0c9e-0000-4000-8000-0000000000ff').expect(404);
    });
  });
});

describe('listing transactions the way the acceptance suite reads them', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: string;
  let account: string;
  let rows: { id: string; startedAt: Date }[];
  let withdrawalId: string;

  beforeAll(async () => {
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
    const kp = Keypair.random();
    account = kp.publicKey();
    jwt = await anchorToken(app, kp);
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: account } });
    rows = [];
    for (let i = 0; i < 3; i += 1) {
      const row = await prisma.sep24Transaction.create({
        data: {
          personId: link!.personId,
          stellarAccount: account,
          assetCode: 'USDC',
          startedAt: new Date(Date.UTC(2026, 0, 1 + i, 12, 0, 0)),
        },
      });
      rows.push({ id: row.id, startedAt: row.startedAt });
    }
    const wd = await prisma.sep24Transaction.create({
      data: {
        personId: link!.personId,
        stellarAccount: account,
        assetCode: 'USDC',
        flow: 'WITHDRAW',
        startedAt: new Date(Date.UTC(2025, 0, 1, 12, 0, 0)),
      },
    });
    withdrawalId = wd.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const list = (qs: string) =>
    request(app.getHttpServer())
      .get(`/sep24/transactions?asset_code=USDC${qs}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

  it('returns them newest first, which the suite checks pairwise', async () => {
    const { body } = await list('');
    const times = body.transactions.map((t: any) => Date.parse(t.started_at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(body.transactions[0].id).toBe(rows[2].id);
  });

  it('treats no_older_than as inclusive, or the suite gets one row where it needs two', async () => {
    const middle = rows[1].startedAt.toISOString();
    const { body } = await list(`&no_older_than=${middle}`);
    const ids = body.transactions.map((t: any) => t.id);
    expect(ids).toContain(rows[1].id);
    expect(ids).toContain(rows[2].id);
    expect(ids).not.toContain(rows[0].id);
  });

  it('honours limit', async () => {
    const { body } = await list('&limit=1');
    expect(body.transactions).toHaveLength(1);
  });

  it('returns exactly the withdrawals for kind=withdrawal, and reports the kind it filtered on', async () => {
    const { body } = await list('&kind=withdrawal');
    expect(body.transactions.map((t: any) => t.id)).toEqual([withdrawalId]);
    expect(body.transactions[0].kind).toBe('withdrawal');
    expect(typeof body.transactions[0].from).toBe('string');
  });

  it('excludes the withdrawal from kind=deposit, which a filter that ignores kind would not', async () => {
    const { body } = await list('&kind=deposit');
    expect(body.transactions.length).toBeGreaterThanOrEqual(3);
    expect(body.transactions.map((t: any) => t.id)).not.toContain(withdrawalId);
    for (const t of body.transactions) expect(t.kind).toBe('deposit');
  });

  it('refuses a kind SEP-24 does not define, rather than quietly returning everything', async () => {
    await request(app.getHttpServer())
      .get('/sep24/transactions?asset_code=USDC&kind=garbage')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(400);
  });

  it('reads an absent kind as absent, not as a filter that matches nothing', async () => {
    const { body } = await list('&kind=');
    expect(body.transactions.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a limit that would reach the database as nonsense', async () => {
    await request(app.getHttpServer())
      .get('/sep24/transactions?asset_code=USDC&limit=1e21')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(400);
  });

  it('says a customer is screened only when a screening actually happened', async () => {
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: account } });
    await prisma.kycVerification.create({
      data: {
        customerRef: account,
        personId: link!.personId,
        status: 'ACCEPTED',
        screenedAt: null,
      },
    });
    const unscreened = await list('');
    expect(unscreened.body.transactions[0].kyc_verified).toBe(false);

    await prisma.kycVerification.update({
      where: { customerRef: account },
      data: { screenedAt: new Date() },
    });
    const screened = await list('');
    expect(screened.body.transactions[0].kyc_verified).toBe(true);
  });
});
