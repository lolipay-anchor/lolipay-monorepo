import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';

const saved = { switch: process.env.SEP24_WITHDRAW_ENABLED, signer: process.env.REFUND_SIGNER_SECRET };

function restoreEnv() {
  for (const [k, v] of [['SEP24_WITHDRAW_ENABLED', saved.switch], ['REFUND_SIGNER_SECRET', saved.signer]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe.each([
  ['a refund signer configured and auto-refund on', Keypair.random().secret(), true, /does it for you/i, /will not do it for you/i],
  ['no refund signer', '', true, /will not do it for you/i, /does it for you/i],
  ['a refund signer configured but auto-refund switched off', Keypair.random().secret(), false, /will not do it for you/i, /does it for you/i],
])('the signing screen promises an automatic refund only when this deployment can deliver one: with %s', (_label, secret, autoRefund, expected, forbidden) => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.SEP24_WITHDRAW_ENABLED = 'true';
    process.env.REFUND_SIGNER_SECRET = secret;
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
    await prisma.config.update({ where: { id: 1 }, data: { autoRefund } });
  });

  afterAll(async () => {
    try {
      await prisma?.config.update({ where: { id: 1 }, data: { autoRefund: true } });
    } finally {
      restoreEnv();
      await app?.close();
    }
  });

  it('says exactly what this deployment will do about the refund route', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const opened = await request(app.getHttpServer())
      .post('/sep24/transactions/withdraw/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const url = new URL(opened.body.url as string);
    const id = url.pathname.split('/').pop() as string;
    const token = url.searchParams.get('token') as string;
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: kp.publicKey() } });
    await prisma.kycVerification.create({
      data: { customerRef: kp.publicKey(), personId: link!.personId, status: 'ACCEPTED', screenedAt: new Date(), verifiedAt: new Date() },
    });
    const order = await prisma.order.create({
      data: {
        tradeId: randomBytes(32).toString('hex'),
        userAddress: kp.publicKey(),
        personId: link!.personId,
        flow: 'WITHDRAW',
        rail: 'BANK',
        usdcAmount: 1_000_0000000n,
        fiatAmount: 16_000_000n,
        rateSnapshot: '16000',
        platformFeeBps: 30,
        lpFeeBps: 0,
        platformWallet: 'GPLATFORM',
        status: 'MATCHED',
        payDeadline: 9_999_999_999n,
        confirmDeadline: 10_000_003_599n,
        disputeDeadline: 10_000_099_999n,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.sep24Transaction.update({ where: { id }, data: { orderId: order.id } });

    const first = await request(app.getHttpServer()).get(`/sep24/interactive/${id}?token=${token}`);
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];
    const res = await request(app.getHttpServer()).get(`/sep24/interactive/${id}`).set('Cookie', cookie);
    expect(res.text).toMatch(expected);
    expect(res.text).not.toMatch(forbidden);
    expect(res.text).toMatch(/24 hours/);
  });
});
