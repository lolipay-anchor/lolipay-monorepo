import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AppModule } from '../app.module';
import { configureHttp } from '../http-setup';
import { AccountSignersService } from '../sep10/account-signers.service';
import { KYC_PROVIDER } from '../kyc/kyc-provider';
import { StubKycProvider } from '../kyc/stub-kyc-provider';
import { AttestorService } from '../stellar/attestor.service';
import { PrismaService } from '../prisma/prisma.service';
import { sessionToken } from '../auth/auth-test-helpers';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

describe('the one door through which a deposit is declared paid', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let attest: jest.Mock;

  const adminKp = Keypair.random();
  const strangerKp = Keypair.random();

  beforeAll(async () => {
    process.env.ADMIN_ADDRESSES = adminKp.publicKey();
    attest = jest.fn(async () => ({ status: 'SUCCESS', hash: 'deadbeef' }));

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .overrideProvider(AccountSignersService)
      .useValue({ load: jest.fn().mockResolvedValue(null) })
      .overrideProvider(KYC_PROVIDER)
      .useValue(new StubKycProvider())
      .overrideProvider(AttestorService)
      .useValue({ attest })
      .compile();

    app = mod.createNestApplication();
    configureHttp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function seedOrder(over: Record<string, unknown> = {}) {
    const person = await prisma.person.create({ data: {} });
    const deadline = 9_999_999_999n;
    return prisma.order.create({
      data: {
        personId: person.id,
        userAddress: Keypair.random().publicKey(),
        flow: 'TOP_UP',
        status: 'FUNDED',
        tradeId: randomBytes(32).toString('hex'),
        contractId: 'CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z',
        usdcAmount: 10_0000000n,
        fiatAmount: 1_600_000n,
        rail: 'BANK',
        rateSnapshot: '16000',
        platformFeeBps: 30,
        lpFeeBps: 20,
        platformWallet: 'GPLATFORM',
        payDeadline: deadline,
        confirmDeadline: deadline,
        disputeDeadline: deadline,
        expiresAt: new Date(Date.now() + 1_800_000),
        ...over,
      },
    });
  }

  it('refuses a caller with no token at all, so the route is not open by omission', async () => {
    const order = await seedOrder();
    await http()
      .post(`/admin/orders/${order.id}/attest`)
      .send({ evidence: 'BCA mutation 12:04' })
      .expect(401);
    expect(attest).not.toHaveBeenCalled();
  });

  it('refuses an authenticated user who is not an admin', async () => {
    const order = await seedOrder();
    const jwt = await sessionToken(app, strangerKp);
    await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ evidence: 'BCA mutation 12:04' })
      .expect(403);
    expect(attest).not.toHaveBeenCalled();
  });

  it('attests a funded top-up against the trade and contract held on the row', async () => {
    const order = await seedOrder();
    const jwt = await sessionToken(app, adminKp);

    const res = await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ evidence: 'BCA mutation 12:04' })
      .expect(200);

    expect(res.body.txHash).toBe('deadbeef');
    expect(attest).toHaveBeenCalledWith(
      'CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z',
      order.tradeId,
    );
  });

  it('refuses a caller who tries to name a trade at all, rather than quietly ignoring them', async () => {
    const order = await seedOrder();
    const jwt = await sessionToken(app, adminKp);

    await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ evidence: 'BCA mutation 12:04', tradeId: 'ff'.repeat(32) })
      .expect(400);

    expect(attest).not.toHaveBeenCalled();
  });

  it('refuses a caller who tries to name a contract', async () => {
    const order = await seedOrder();
    const jwt = await sessionToken(app, adminKp);

    await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ evidence: 'BCA mutation 12:04', contractId: 'CBOGUS' })
      .expect(400);

    expect(attest).not.toHaveBeenCalled();
  });

  it('records who attested and on what evidence, because nothing else holds it for a top-up', async () => {
    const order = await seedOrder();
    const jwt = await sessionToken(app, adminKp);
    await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ evidence: 'BCA mutation 12:04' })
      .expect(200);

    const row = await prisma.adminAudit.findFirst({
      where: { targetId: order.id, action: 'order.attestFiatPaid' },
    });
    expect(row).toBeTruthy();
    expect(row!.actorAddress).toBe(adminKp.publicKey());
    expect(JSON.stringify(row!.after)).toContain('BCA mutation 12:04');
  });

  it('refuses an order that is not a top-up', async () => {
    const order = await seedOrder({ flow: 'WITHDRAW' });
    const jwt = await sessionToken(app, adminKp);
    await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ evidence: 'BCA mutation 12:04' })
      .expect(400);
    expect(attest).not.toHaveBeenCalled();
  });

  it('refuses an order that is not FUNDED, which is what a second operator meets', async () => {
    const order = await seedOrder({ status: 'FIAT_PAID' });
    const jwt = await sessionToken(app, adminKp);
    const res = await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ evidence: 'BCA mutation 12:04' })
      .expect(409);
    expect(res.body.message).toMatch(/FIAT_PAID/);
    expect(attest).not.toHaveBeenCalled();
  });

  it('does not report success when the chain refused the transaction', async () => {
    const order = await seedOrder();
    const jwt = await sessionToken(app, adminKp);
    attest.mockResolvedValueOnce({ status: 'FAILED', hash: 'cafe1234' });

    const res = await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ evidence: 'BCA mutation 12:04' })
      .expect(502);

    expect(JSON.stringify(res.body)).toContain('cafe1234');
  });

  it('records the attempt even when the chain refused, because the evidence lives nowhere else', async () => {
    const order = await seedOrder();
    const jwt = await sessionToken(app, adminKp);
    attest.mockResolvedValueOnce({ status: 'FAILED', hash: 'cafe5678' });

    await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ evidence: 'BCA mutation 12:04' })
      .expect(502);

    const row = await prisma.adminAudit.findFirst({
      where: { targetId: order.id, action: 'order.attestFiatPaid' },
    });
    expect(row).toBeTruthy();
    expect(JSON.stringify(row!.after)).toContain('FAILED');
  });

  it('records the attempt even when submitting threw, so a poll timeout leaves a trail', async () => {
    const order = await seedOrder();
    const jwt = await sessionToken(app, adminKp);
    attest.mockRejectedValueOnce(new Error('AttestorService: getTransaction poll timed out'));

    await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ evidence: 'BCA mutation 12:04' })
      .expect(500);

    const row = await prisma.adminAudit.findFirst({
      where: { targetId: order.id, action: 'order.attestFiatPaid' },
    });
    expect(row).toBeTruthy();
    expect(JSON.stringify(row!.after)).toMatch(/poll timed out/);
  });

  it('reads an unconfigured attestor as unavailable, not as a broken anchor', async () => {
    const order = await seedOrder();
    const jwt = await sessionToken(app, adminKp);
    attest.mockRejectedValueOnce(
      new ServiceUnavailableException(
        'this anchor cannot attest deposits right now: no attestor key is configured',
      ),
    );

    await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ evidence: 'BCA mutation 12:04' })
      .expect(503);
  });

  it('does not discard an attestation that already landed because its audit row would not write', async () => {
    const order = await seedOrder();
    const jwt = await sessionToken(app, adminKp);
    attest.mockResolvedValueOnce({ status: 'SUCCESS', hash: 'a11ceb0b' });
    const create = jest
      .spyOn(prisma.adminAudit, 'create')
      .mockRejectedValueOnce(new Error('the audit write failed'));

    const res = await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ evidence: 'BCA mutation 12:04' })
      .expect(200);

    expect(res.body.txHash).toBe('a11ceb0b');
    create.mockRestore();
  });

  it('refuses an attestation with no evidence recorded', async () => {
    const order = await seedOrder();
    const jwt = await sessionToken(app, adminKp);
    await http()
      .post(`/admin/orders/${order.id}/attest`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({})
      .expect(400);
    expect(attest).not.toHaveBeenCalled();
  });

  beforeEach(() => attest.mockClear());
});
