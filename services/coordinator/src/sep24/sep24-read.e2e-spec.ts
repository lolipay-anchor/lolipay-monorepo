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
