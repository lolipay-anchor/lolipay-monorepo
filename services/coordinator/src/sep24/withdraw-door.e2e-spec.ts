import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';

describe('the withdrawal door, with the switch on', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saved: string | undefined;

  beforeAll(async () => {
    saved = process.env.SEP24_WITHDRAW_ENABLED;
    process.env.SEP24_WITHDRAW_ENABLED = 'true';
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.SEP24_WITHDRAW_ENABLED;
    else process.env.SEP24_WITHDRAW_ENABLED = saved;
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function open(body: Record<string, unknown>) {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post('/sep24/transactions/withdraw/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send(body);
    return { res, address: kp.publicKey() };
  }

  it('records the row as a withdrawal, which is the whole point of the separate door', async () => {
    const { res, address } = await open({ asset_code: 'USDC' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('interactive_customer_info_needed');
    const row = await prisma.sep24Transaction.findFirst({ where: { stellarAccount: address } });
    expect(row!.flow).toBe('WITHDRAW');
  });

  it('leaves the deposit door recording deposits, so one flow did not overwrite the other', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const row = await prisma.sep24Transaction.findFirst({
      where: { stellarAccount: kp.publicKey() },
    });
    expect(row!.flow).toBe('TOP_UP');
  });

  it('refuses an asset it does not serve', async () => {
    const { res } = await open({ asset_code: 'BADCODE' });
    expect(res.status).toBe(400);
  });

  it('refuses a withdrawal that names somebody else as the account', async () => {
    const stranger = Keypair.random().publicKey();
    const { res } = await open({ asset_code: 'USDC', account: stranger });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/withdraws from the account its token speaks for/i);
    expect(res.body.message).not.toMatch(/deposit/i);
  });

  it('surfaces the row through the read endpoints as a withdrawal', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await http()
      .post('/sep24/transactions/withdraw/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);

    const { body } = await http()
      .get('/sep24/transactions?asset_code=USDC&kind=withdrawal')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].kind).toBe('withdrawal');
    expect(body.transactions[0].from).toBe(kp.publicKey());
    expect(body.transactions[0].to).toBeNull();
  });
});
