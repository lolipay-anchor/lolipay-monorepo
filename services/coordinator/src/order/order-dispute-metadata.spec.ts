import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrderService } from './order.service';
import { makeUserReputationStub, orderStatusFor, orderTxFor } from './test-helpers';
import { FakeObjectStorage } from '../storage/object-storage.fake';

describe('OrderService — dispute metadata + post-settle window (Phase 5B Task 4)', () => {
  const USER_ADDR = 'GUSER';
  const LP_ADDR = 'GLP';
  const STRANGER_ADDR = 'GSTRANGER';
  const PLATFORM = 'GPLATFORM';
  const FAKE_TRADE_ID = 'a'.repeat(64);
  const CONFIG = { postSettleDisputeWindowSecs: 3600, requireProof: false };

  function makeOrder(overrides: Partial<any> = {}): any {
    return {
      id: 'order-1',
      tradeId: FAKE_TRADE_ID,
      contractId: 'CTEST',
      userAddress: USER_ADDR,
      flow: 'WITHDRAW',
      status: 'FIAT_PAID',
      fiatCurrency: 'IDR',
      usdcAmount: BigInt('100000000'),
      fiatAmount: BigInt('1600000'),
      rateSnapshot: '16000',
      platformFeeBps: 30,
      lpFeeBps: 120,
      platformWallet: PLATFORM,
      lpWallet: LP_ADDR,
      lpId: 'lp1',
      lp: { stellarAddress: LP_ADDR, online: true, approvedAt: new Date(), createdAt: new Date() },
      settledAt: null,
      disputeBy: null,
      disputeReason: null,
      disputeNote: null,
      disputeEvidenceUrl: null,
      disputeAt: null,
      resolution: null,
      payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
      rail: 'BANK',
      expiresAt: new Date(),
      createdAt: new Date(),
      ...overrides,
    };
  }

  function makeSvc(
    orderOverrides: Partial<any> = {},
    opts: {
      updateManyCount?: number;
      configOverrides?: Partial<any>;
      stellarOverrides?: any;
      findManyOrders?: any[];
    } = {},
  ) {
    let current = makeOrder(orderOverrides);
    const prisma = {
      order: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...current })),
        update: jest.fn().mockImplementation(({ data }: any) => {
          current = { ...current, ...data };
          return Promise.resolve({ ...current });
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
          const statusMatches = !('status' in where) || current.status === where.status;
          const disputeByMatches = !('disputeBy' in where) || current.disputeBy === where.disputeBy;
          const disputeReasonMatches = !('disputeReason' in where) || current.disputeReason === where.disputeReason;
          const count = opts.updateManyCount ?? (statusMatches && disputeByMatches && disputeReasonMatches ? 1 : 0);
          if (count > 0) current = { ...current, ...data };
          return Promise.resolve({ count });
        }),
        findMany: jest.fn().mockResolvedValue(opts.findManyOrders ?? []),
        count: jest.fn().mockResolvedValue(0),
      },
      quote: {},
      config: {
        upsert: jest.fn().mockResolvedValue({ ...CONFIG, ...opts.configOverrides }),
      },
      lp: { findUnique: jest.fn() },
    } as any;

    const stellar = {
      buildMarkFiatPaidTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      buildCreateTradeTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      buildConfirmReleaseTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      buildRaiseDisputeTx: jest.fn().mockResolvedValue({ xdr: 'DISPUTE_XDR', networkPassphrase: 'p' }),
      buildResolveTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      getTradeStatus: jest.fn().mockResolvedValue(null),
      getTradeStatusStrict: jest.fn().mockResolvedValue(null),
      ...opts.stellarOverrides,
    } as any;

    const matching = { pickLp: jest.fn() } as any;
    const cfg = {
      platformWallet: PLATFORM,
      escrowContractId: 'CENV',
      adminAddresses: [],
    } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const storage = new FakeObjectStorage();

    return {
      svc: new OrderService(prisma, stellar, matching, cfg, markets, notifications, storage as any, makeUserReputationStub(), orderStatusFor(prisma, stellar, cfg), orderTxFor(prisma, stellar, cfg)),
      tx: orderTxFor(prisma, stellar, cfg),
      prisma,
      stellar,
      storage,
    };
  }

  async function writeEvidenceFile(storage: FakeObjectStorage, key: string): Promise<string> {
    const relative = `evidence/${key}.jpg`;
    await storage.putObject(relative, Buffer.from('fake-jpg'), 'image/jpeg');
    return relative;
  }

  it('order not found → 404', async () => {
    const { svc, tx, prisma } = makeSvc();
    prisma.order.findUnique.mockResolvedValueOnce(null);
    await expect(
      svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'never got it', undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a non-party (neither user nor LP) is forbidden', async () => {
    const { svc, tx } = makeSvc();
    await expect(
      svc.postDispute('order-1', STRANGER_ADDR, 'PAYMENT_NOT_RECEIVED', 'never got it', undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('FIAT_PAID: allowed for either party', async () => {
    const { svc, tx } = makeSvc({ status: 'FIAT_PAID' });
    const result = await svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'never got it', undefined);
    expect(result.order.dispute_by).toBe('user');
    expect(result.dispute_tx.xdr).toBe('DISPUTE_XDR');
  });

  it('RELEASED within the post-settle window → allowed', async () => {
    const { svc, tx } = makeSvc({ status: 'RELEASED', settledAt: new Date(Date.now() - 60_000) });
    const result = await svc.postDispute('order-1', LP_ADDR, 'PAYMENT_NOT_RECEIVED', 'buyer says unpaid', undefined);
    expect(result.order.dispute_by).toBe('lp');
  });

  it('RELEASED PAST the post-settle window → 409', async () => {
    const { svc, tx } = makeSvc({ status: 'RELEASED', settledAt: new Date(Date.now() - 999 * 60 * 60 * 1000) });
    await expect(
      svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'too late', undefined),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('boundary: a few seconds before the window edge is still disputable (exact-millisecond inclusivity is covered by dispute.util.spec.ts)', async () => {
    const { svc, tx } = makeSvc({
      status: 'REFUNDED',
      settledAt: new Date(Date.now() - (CONFIG.postSettleDisputeWindowSecs - 5) * 1000),
    });
    const result = await svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'edge case', undefined);
    expect(result.order.dispute_by).toBe('user');
  });

  it('a never-disputable status (e.g. FUNDED) → 409', async () => {
    const { svc, tx } = makeSvc({ status: 'FUNDED' });
    await expect(
      svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'too early', undefined),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('TOP_UP order: WITHDRAW-only reason (PAYMENT_NOT_RECEIVED) is rejected → 400', async () => {
    const { svc, tx } = makeSvc({ flow: 'TOP_UP', status: 'FIAT_PAID' });
    await expect(
      svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'wrong reason for this flow', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('TOP_UP order: USDC_NOT_RELEASED is accepted', async () => {
    const { svc, tx } = makeSvc({ flow: 'TOP_UP', status: 'FIAT_PAID' });
    const result = await svc.postDispute('order-1', USER_ADDR, 'USDC_NOT_RELEASED', 'no usdc arrived', undefined);
    expect(result.order.dispute_reason).toBe('USDC_NOT_RELEASED');
  });

  it('WITHDRAW order: TOP_UP-only reason (USDC_NOT_RELEASED) is rejected → 400', async () => {
    const { svc, tx } = makeSvc({ flow: 'WITHDRAW', status: 'FIAT_PAID' });
    await expect(
      svc.postDispute('order-1', USER_ADDR, 'USDC_NOT_RELEASED', 'wrong reason for this flow', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('WITHDRAW order: FAKE_PROOF is accepted', async () => {
    const { svc, tx } = makeSvc({ flow: 'WITHDRAW', status: 'FIAT_PAID' });
    const result = await svc.postDispute('order-1', USER_ADDR, 'FAKE_PROOF', 'the screenshot looks edited', undefined);
    expect(result.order.dispute_reason).toBe('FAKE_PROOF');
  });

  it.each(['TOP_UP', 'WITHDRAW'])('OTHER is accepted for every flow (%s)', async (flow) => {
    const { svc, tx } = makeSvc({ flow, status: 'FIAT_PAID' });
    const result = await svc.postDispute('order-1', USER_ADDR, 'OTHER', 'something else entirely', undefined);
    expect(result.order.dispute_reason).toBe('OTHER');
  });

  it('a whitespace-only note is rejected (trims to empty) → 400', async () => {
    const { svc, tx } = makeSvc({ status: 'FIAT_PAID' });
    await expect(svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', '   ', undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('note is trimmed before persisting', async () => {
    const { svc, tx } = makeSvc({ status: 'FIAT_PAID' });
    const result = await svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', '  needs review  ', undefined);
    expect(result.order.dispute_note).toBe('needs review');
  });

  it('a second submission after disputeBy is already set → 409 (read-time check)', async () => {
    const { svc, tx } = makeSvc({ status: 'FIAT_PAID', disputeBy: 'user' });
    await expect(
      svc.postDispute('order-1', LP_ADDR, 'PAYMENT_NOT_RECEIVED', 'lp disagrees', undefined),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('a race where disputeBy gets set between read and write → 409 (write-time guard), not a crash', async () => {
    const { svc, tx } = makeSvc({ status: 'FIAT_PAID' }, { updateManyCount: 0 });
    await expect(
      svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'raced', undefined),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('a party whose role was just reconciled onto disputeBy (reason still null) may refill their own metadata — 200, not 409', async () => {
    const { svc, tx, prisma } = makeSvc({
      status: 'FIAT_PAID',
      disputeBy: 'lp',
      disputeReason: null,
      disputeNote: null,
      disputeEvidenceUrl: null,
    });
    const result = await svc.postDispute('order-1', LP_ADDR, 'PAYMENT_NOT_RECEIVED', 'the buyer never paid', undefined);
    expect(result.order.dispute_by).toBe('lp');
    expect(result.order.dispute_reason).toBe('PAYMENT_NOT_RECEIVED');
    expect(result.order.dispute_note).toBe('the buyer never paid');
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', disputeBy: 'lp', disputeReason: null },
      data: expect.objectContaining({ disputeBy: 'lp', disputeReason: 'PAYMENT_NOT_RECEIVED' }),
    });
  });

  it('the OTHER party (not the reconciled role) still gets 409 even though disputeReason is null', async () => {
    const { svc, tx } = makeSvc({
      status: 'FIAT_PAID',
      disputeBy: 'lp',
      disputeReason: null,
    });
    await expect(
      svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'not my dispute to refill', undefined),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('the SAME party retrying once a reason is already on file (no reconciliation happened) still gets 409', async () => {
    const { svc, tx } = makeSvc({
      status: 'FIAT_PAID',
      disputeBy: 'user',
      disputeReason: 'PAYMENT_NOT_RECEIVED',
    });
    await expect(
      svc.postDispute('order-1', USER_ADDR, 'WRONG_AMOUNT', 'trying to change my mind', undefined),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('a refill race (two concurrent refill attempts) → only one wins, the loser gets 409 (write-time guard)', async () => {
    const { svc, tx } = makeSvc(
      { status: 'FIAT_PAID', disputeBy: 'lp', disputeReason: null },
      { updateManyCount: 0 },
    );
    await expect(
      svc.postDispute('order-1', LP_ADDR, 'PAYMENT_NOT_RECEIVED', 'raced refill', undefined),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('evidenceUrl that does not match the CALLER\'s own deterministic path (e.g. the OTHER party\'s file) → 400', async () => {
    const { svc, tx } = makeSvc({ status: 'FIAT_PAID' });

    await expect(
      svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'attaching', 'evidence/order-1-lp.jpg'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('evidenceUrl for a DIFFERENT order id → 400', async () => {
    const { svc, tx } = makeSvc({ status: 'FIAT_PAID' });
    await expect(
      svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'attaching', 'evidence/order-999-user.jpg'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a well-formed OWN path that was never actually uploaded (no file on disk) → 400', async () => {
    const { svc, tx } = makeSvc({ status: 'FIAT_PAID' });
    await expect(
      svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'attaching', 'evidence/order-1-user.jpg'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a genuinely-uploaded own evidence file → accepted, disputeEvidenceUrl persisted', async () => {
    const { svc, tx, storage } = makeSvc({ status: 'FIAT_PAID' });
    const relative = await writeEvidenceFile(storage, 'order-1-user');
    const result = await svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'see attached', relative);
    expect(result.order.dispute_evidence_url).toBe(relative);
  });

  it('the LP\'s own genuinely-uploaded evidence file → accepted', async () => {
    const { svc, tx, storage } = makeSvc({ status: 'FIAT_PAID' });
    const relative = await writeEvidenceFile(storage, 'order-1-lp');
    const result = await svc.postDispute('order-1', LP_ADDR, 'PAYMENT_NOT_RECEIVED', 'see attached', relative);
    expect(result.order.dispute_by).toBe('lp');
    expect(result.order.dispute_evidence_url).toBe(relative);
  });

  it('returns the unsigned raise-dispute XDR alongside the persisted order (one round-trip)', async () => {
    const { svc, tx, stellar } = makeSvc({ status: 'FIAT_PAID' });
    const result = await svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'see notes', undefined);
    expect(result.dispute_tx).toEqual({ xdr: 'DISPUTE_XDR', networkPassphrase: 'p' });
    expect(stellar.buildRaiseDisputeTx).toHaveBeenCalledWith('CTEST', USER_ADDR, FAKE_TRADE_ID);
  });

  it('disputeAt is stamped now on first filing', async () => {
    const before = Date.now();
    const { svc, tx } = makeSvc({ status: 'FIAT_PAID' });
    const result = await svc.postDispute('order-1', USER_ADDR, 'PAYMENT_NOT_RECEIVED', 'see notes', undefined);
    expect(result.order.dispute_at).toBeInstanceOf(Date);
    expect((result.order.dispute_at as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  describe('buildRaiseDisputeTx — relaxed to canDispute (FIAT_PAID or post-settle window)', () => {
    it('FIAT_PAID → still succeeds (unchanged behaviour)', async () => {
      const { svc, tx } = makeSvc({ status: 'FIAT_PAID' });
      const result = await tx.buildRaiseDisputeTx('order-1', USER_ADDR);
      expect(result.xdr).toBe('DISPUTE_XDR');
    });

    it('RELEASED within the post-settle window → NOW succeeds (previously would have 409ed)', async () => {
      const { svc, tx } = makeSvc({ status: 'RELEASED', settledAt: new Date(Date.now() - 60_000) });
      const result = await tx.buildRaiseDisputeTx('order-1', LP_ADDR);
      expect(result.xdr).toBe('DISPUTE_XDR');
    });

    it('RELEASED past the post-settle window → 409', async () => {
      const { svc, tx } = makeSvc({ status: 'RELEASED', settledAt: new Date(Date.now() - 999 * 60 * 60 * 1000) });
      await expect(tx.buildRaiseDisputeTx('order-1', USER_ADDR)).rejects.toBeInstanceOf(ConflictException);
    });

    it('FUNDED (never disputable) → 409', async () => {
      const { svc, tx } = makeSvc({ status: 'FUNDED' });
      await expect(tx.buildRaiseDisputeTx('order-1', USER_ADDR)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('serializeOrderBase — post_settle_dispute_until', () => {
    it('getOrder: RELEASED within window, not yet disputed → an ISO deadline string', async () => {
      const settledAt = new Date(Date.now() - 60_000);
      const { svc, tx } = makeSvc({ status: 'RELEASED', settledAt });
      const result = await svc.getOrder('order-1', USER_ADDR);
      expect(result.post_settle_dispute_until).toBe(
        new Date(settledAt.getTime() + CONFIG.postSettleDisputeWindowSecs * 1000).toISOString(),
      );
    });

    it('getOrder: RELEASED past the window → null', async () => {
      const settledAt = new Date(Date.now() - 999 * 60 * 60 * 1000);
      const { svc, tx } = makeSvc({ status: 'RELEASED', settledAt });
      const result = await svc.getOrder('order-1', USER_ADDR);
      expect(result.post_settle_dispute_until).toBeNull();
    });

    it('getOrder: RELEASED within window but already disputed (disputeBy set) → null', async () => {
      const settledAt = new Date(Date.now() - 60_000);
      const { svc, tx } = makeSvc({ status: 'RELEASED', settledAt, disputeBy: 'user' });
      const result = await svc.getOrder('order-1', USER_ADDR);
      expect(result.post_settle_dispute_until).toBeNull();
    });

    it('getOrder: a non-settled status (e.g. FIAT_PAID) → null', async () => {
      const { svc, tx } = makeSvc({ status: 'FIAT_PAID' });
      const result = await svc.getOrder('order-1', USER_ADDR);
      expect(result.post_settle_dispute_until).toBeNull();
    });

    it('listOrders: surfaces the same computed field as getOrder', async () => {
      const settledAt = new Date(Date.now() - 60_000);
      const row = makeOrder({ status: 'REFUNDED', settledAt });
      const { svc, tx } = makeSvc({}, { findManyOrders: [row] });
      const [serialized] = await svc.listOrders(USER_ADDR);
      expect(serialized.post_settle_dispute_until).toBe(
        new Date(settledAt.getTime() + CONFIG.postSettleDisputeWindowSecs * 1000).toISOString(),
      );
    });

    it('a resolver-raised dispute is visible, and does not read as a party filing', async () => {
      const settledAt = new Date(Date.now() - 60_000);
      const { svc } = makeSvc({ status: 'RELEASED', settledAt, resolverDisputed: true });
      const result = await svc.getOrder('order-1', USER_ADDR);
      expect(result.resolver_disputed).toBe(true);
      expect(result.dispute_by).toBeNull();
    });

    it('an order nobody escalated reports the flag as false, never undefined', async () => {
      const { svc } = makeSvc({ status: 'RELEASED', settledAt: new Date(Date.now() - 60_000) });
      const result = await svc.getOrder('order-1', USER_ADDR);
      expect(result.resolver_disputed).toBe(false);
    });

    it('the deadline the chain latched wins over the configured window', async () => {
      const settledAt = new Date(Date.now() - 60_000);
      const latched = BigInt(Math.floor(Date.now() / 1000) + 45);
      const { svc } = makeSvc({ status: 'RELEASED', settledAt, postSettleDeadline: latched });
      const result = await svc.getOrder('order-1', USER_ADDR);
      expect(result.post_settle_dispute_until).toBe(
        new Date(Number(latched) * 1000).toISOString(),
      );
    });
  });
});
