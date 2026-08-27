import { OrderService } from './order.service';
import { makeUserReputationStub, withTxSupport, orderStatusFor, orderTxFor, verifiedCustomerStub } from './test-helpers';

const fakeStorage = {} as any;

describe('OrderService — Phase 5A per-order contractId cutover', () => {
  const USER_ADDR = 'GUSER';
  const LP_ADDR = 'GLP';
  const PLATFORM = 'GPLATFORM';
  const ENV_CONTRACT = 'CENV_DEFAULT';
  const SNAPSHOTTED_CONTRACT = 'CORDER_SNAPSHOT';
  const FAKE_TRADE_ID = 'a'.repeat(64);

  function makeOrder(overrides: Partial<any> = {}): any {
    return {
      id: 'order-1',
      tradeId: FAKE_TRADE_ID,
      contractId: SNAPSHOTTED_CONTRACT,
      userAddress: USER_ADDR,
      flow: 'TOP_UP',
      status: 'FUNDED',
      fiatCurrency: 'IDR',
      usdcAmount: BigInt('100000000'),
      fiatAmount: BigInt('1600000'),
      platformFeeBps: 30,
      lpFeeBps: 120,
      platformWallet: PLATFORM,
      lpWallet: LP_ADDR,
      payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
      lp: { stellarAddress: LP_ADDR, approvedAt: new Date(), createdAt: new Date(), online: true },
      ...overrides,
    };
  }

  function makeSvc(orderOverrides: Partial<any> = {}, stellarOverrides: any = {}) {
    const order = makeOrder(orderOverrides);
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(order),
        update: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      quote: {},
      config: { upsert: jest.fn() },
      lp: { findUnique: jest.fn() },
    } as any;

    const stellar = { getStakeInfo: jest.fn().mockResolvedValue({ staked: '1000000000000', unbonding: '0', unbond_available_at: 0, min_stake: '1', eligible: true }), 
      buildMarkFiatPaidTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      buildCreateTradeTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      buildConfirmReleaseTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      buildRaiseDisputeTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      buildResolveTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      getTradeStatus: jest.fn().mockResolvedValue(null),
      getTradeStatusStrict: jest.fn().mockResolvedValue(null),
      ...stellarOverrides,
    } as any;

    const matching = { pickLp: jest.fn() } as any;
    const cfg = { platformWallet: PLATFORM, escrowContractId: ENV_CONTRACT } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;

    return { svc: new OrderService(prisma, stellar, matching, cfg, markets, notifications, fakeStorage, makeUserReputationStub(), orderStatusFor(prisma, stellar, cfg), orderTxFor(prisma, stellar, cfg)), prisma, stellar, order, tx: orderTxFor(prisma, stellar, cfg) };
  }

  it('createFromQuote snapshots contractId = cfg.escrowContractId on the new order', async () => {
    const quote = {
      id: 'q1',
      userAddress: USER_ADDR,
      flow: 'TOP_UP',
      rail: 'BANK',
      usdcAmount: 100_000_000n,
      fiatAmount: 1_600_000n,
      fiatCurrency: 'IDR',
      rateSnapshot: '16000',
      platformFeeBps: 30,
      lpFeeBps: 120,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const prisma = {
      quote: {
        findUnique: jest.fn().mockResolvedValue(quote),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: 'ord-1',
            tradeId: 't1',
            lpId: 'lp1',
            platformWallet: PLATFORM,
            lpWallet: LP_ADDR,
            status: 'MATCHED',
            payDeadline: BigInt(0),
            confirmDeadline: BigInt(0),
            disputeDeadline: BigInt(0),
            expiresAt: new Date(),
            createdAt: new Date(),
            ...data,
          }),
        ),
      },
      config: {
        upsert: jest.fn().mockResolvedValue({
          id: 1,
          paused: false,
          minOrder: 1n,
          maxOrder: 10_000_000_000n,
          platformWallet: PLATFORM,
          payWindowSecs: 1800,
          confirmWindowSecs: 1800,
          disputeWindowSecs: 1800,
        }),
      },
    } as any;
    (prisma as any).kycVerification = verifiedCustomerStub();
    withTxSupport(prisma);
    const stellar = { getStakeInfo: jest.fn().mockResolvedValue({ staked: '1000000000000', unbonding: '0', unbond_available_at: 0, min_stake: '1', eligible: true }),  hasUsdcTrustline: jest.fn().mockResolvedValue(true) } as any;
    const matching = {
      pickLp: jest.fn().mockResolvedValue({ staked: 1000000000000n, id: 'lp1', stellarAddress: LP_ADDR, paymentMethodId: 'pm1', details: 'BCA 123' }),
    } as any;
    const cfg = { platformWallet: PLATFORM, escrowContractId: ENV_CONTRACT } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new OrderService(prisma, stellar, matching, cfg, markets, notifications, fakeStorage, makeUserReputationStub(), orderStatusFor(prisma, stellar, cfg), orderTxFor(prisma, stellar, cfg));

    await svc.createFromQuote(USER_ADDR, 'q1');

    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contractId: ENV_CONTRACT }) }),
    );
  });

  it('buildMarkFiatPaidTx targets order.contractId (not the env default)', async () => {
    const { svc, tx, stellar } = makeSvc();
    await tx.buildMarkFiatPaidTx('order-1', USER_ADDR);
    expect(stellar.buildMarkFiatPaidTx).toHaveBeenCalledWith(SNAPSHOTTED_CONTRACT, USER_ADDR, FAKE_TRADE_ID);
  });

  it('buildMarkFiatPaidTx falls back to cfg.escrowContractId for a legacy order (contractId NULL)', async () => {
    const { svc, tx, stellar } = makeSvc({ contractId: null });
    await tx.buildMarkFiatPaidTx('order-1', USER_ADDR);
    expect(stellar.buildMarkFiatPaidTx).toHaveBeenCalledWith(ENV_CONTRACT, USER_ADDR, FAKE_TRADE_ID);
  });

  it('buildCreateTradeTx targets order.contractId', async () => {
    const { svc, tx, stellar } = makeSvc({ status: 'MATCHED' });
    await tx.buildCreateTradeTx('order-1', LP_ADDR);
    expect(stellar.buildCreateTradeTx).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: SNAPSHOTTED_CONTRACT }),
    );
  });

  it('buildCreateTradeTx falls back to cfg.escrowContractId for a legacy order', async () => {
    const { svc, tx, stellar } = makeSvc({ status: 'MATCHED', contractId: null });
    await tx.buildCreateTradeTx('order-1', LP_ADDR);
    expect(stellar.buildCreateTradeTx).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: ENV_CONTRACT }),
    );
  });

  it('buildConfirmReleaseTx targets order.contractId', async () => {
    const { svc, tx, stellar } = makeSvc({ status: 'FIAT_PAID' });
    await tx.buildConfirmReleaseTx('order-1', LP_ADDR);
    expect(stellar.buildConfirmReleaseTx).toHaveBeenCalledWith(SNAPSHOTTED_CONTRACT, LP_ADDR, FAKE_TRADE_ID);
  });

  it('buildRaiseDisputeTx targets order.contractId', async () => {
    const { svc, tx, stellar } = makeSvc({ status: 'FIAT_PAID' });
    await tx.buildRaiseDisputeTx('order-1', LP_ADDR);
    expect(stellar.buildRaiseDisputeTx).toHaveBeenCalledWith(SNAPSHOTTED_CONTRACT, LP_ADDR, FAKE_TRADE_ID);
  });

  it('buildResolveTx targets order.contractId', async () => {
    const { svc, tx, stellar } = makeSvc({ status: 'DISPUTED' });
    await tx.buildResolveTx('order-1', LP_ADDR, 'release');
    expect(stellar.buildResolveTx).toHaveBeenCalledWith(SNAPSHOTTED_CONTRACT, LP_ADDR, FAKE_TRADE_ID, 'release');
  });

  it('cancelOrder\'s strict on-chain read targets order.contractId', async () => {
    const { svc, tx, stellar } = makeSvc({ status: 'MATCHED' });
    await svc.cancelOrder('order-1', USER_ADDR);
    expect(stellar.getTradeStatusStrict).toHaveBeenCalledWith(SNAPSHOTTED_CONTRACT, FAKE_TRADE_ID);
  });

  it('getOrder\'s chain refresh targets order.contractId', async () => {
    const { svc, tx, stellar } = makeSvc({ status: 'FUNDED' });
    await svc.getOrder('order-1', USER_ADDR);
    expect(stellar.getTradeStatus).toHaveBeenCalledWith(SNAPSHOTTED_CONTRACT, FAKE_TRADE_ID);
  });

  it('getOrder\'s chain refresh falls back to cfg.escrowContractId for a legacy order', async () => {
    const { svc, tx, stellar } = makeSvc({ status: 'FUNDED', contractId: null });
    await svc.getOrder('order-1', USER_ADDR);
    expect(stellar.getTradeStatus).toHaveBeenCalledWith(ENV_CONTRACT, FAKE_TRADE_ID);
  });

  it("listLpAssignments' chain refresh targets order.contractId (not the env default)", async () => {
    const { svc, tx, prisma, stellar, order } = makeSvc({ status: 'FUNDED' });
    prisma.lp.findUnique = jest.fn().mockResolvedValue({ id: 'lp1', stellarAddress: LP_ADDR });
    prisma.order.findMany = jest.fn().mockResolvedValue([order]);

    await svc.listLpAssignments(LP_ADDR);

    expect(stellar.getTradeStatus).toHaveBeenCalledWith(SNAPSHOTTED_CONTRACT, FAKE_TRADE_ID);
  });

  it('listLpAssignments falls back to cfg.escrowContractId for a legacy order (contractId NULL)', async () => {
    const { svc, tx, prisma, stellar, order } = makeSvc({ status: 'FUNDED', contractId: null });
    prisma.lp.findUnique = jest.fn().mockResolvedValue({ id: 'lp1', stellarAddress: LP_ADDR });
    prisma.order.findMany = jest.fn().mockResolvedValue([order]);

    await svc.listLpAssignments(LP_ADDR);

    expect(stellar.getTradeStatus).toHaveBeenCalledWith(ENV_CONTRACT, FAKE_TRADE_ID);
  });
});
