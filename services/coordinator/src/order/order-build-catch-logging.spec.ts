import { ServiceUnavailableException } from '@nestjs/common';
import { OrderService } from './order.service';
import { makeUserReputationStub, orderStatusFor, orderTxFor } from './test-helpers';

describe('OrderService — masked build-catch server-side logging (Fix 2)', () => {
  const USER_ADDR = 'GUSER';
  const LP_ADDR = 'GLP';
  const PLATFORM = 'GPLATFORM';
  const FAKE_TRADE_ID = 'a'.repeat(64);
  const fakeStorage = {} as any;

  function makeOrder(overrides: Partial<any> = {}): any {
    return {
      id: 'order-1',
      tradeId: FAKE_TRADE_ID,
      contractId: 'CTEST',
      userAddress: USER_ADDR,
      flow: 'WITHDRAW',
      status: 'MATCHED',
      fiatCurrency: 'IDR',
      usdcAmount: BigInt('100000000'),
      fiatAmount: BigInt('1600000'),
      rateSnapshot: '16000',
      platformFeeBps: 30,
      lpFeeBps: 120,
      platformWallet: PLATFORM,
      lpWallet: LP_ADDR,
      lpId: 'lp1',
      lp: { stellarAddress: LP_ADDR },
      payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
      rail: 'QRIS',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      ...overrides,
    };
  }

  function makeSvc(orderOverrides: Partial<any> = {}, stellarOverrides: any = {}) {
    const order = makeOrder(orderOverrides);
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({ ...order }),
        update: jest.fn().mockResolvedValue({ ...order }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([order]),
        count: jest.fn().mockResolvedValue(0),
      },
      quote: {},
      config: { upsert: jest.fn().mockResolvedValue({ id: 1, requireProof: false }) },
      lp: { findUnique: jest.fn() },
    } as any;

    const stellar = {
      buildMarkFiatPaidTx: jest.fn(),
      buildCreateTradeTx: jest.fn(),
      buildConfirmReleaseTx: jest.fn(),
      buildRaiseDisputeTx: jest.fn(),
      buildResolveTx: jest.fn(),
      readDisputeSigners: jest.fn().mockResolvedValue({ resolver: 'GADMIN', admin: 'GADMIN' }),
      getTradeStatus: jest.fn().mockResolvedValue(null),
      getTradeStatusStrict: jest.fn().mockResolvedValue(null),
      ...stellarOverrides,
    } as any;

    const matching = { pickLp: jest.fn() } as any;
    const cfg = { platformWallet: PLATFORM, escrowContractId: 'CENV' } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;

    return {
      svc: orderTxFor(prisma, stellar, cfg),
      prisma,
      stellar,
      order,
    };
  }

  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('buildMarkFiatPaidTx: logs the real error and still throws ServiceUnavailableException', async () => {
    const { svc } = makeSvc(
      { status: 'FUNDED' },
      { buildMarkFiatPaidTx: jest.fn().mockRejectedValue(new Error('prepareTransaction failed: boom')) },
    );
    await expect(svc.buildMarkFiatPaidTx('order-1', LP_ADDR)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(errSpy).toHaveBeenCalledWith('buildMarkFiatPaidTx error:', expect.stringContaining('boom'));
  });

  it('buildCreateTradeTx: logs the real error and still throws ServiceUnavailableException', async () => {
    const { svc } = makeSvc(
      { status: 'AWAITING_ONCHAIN' },
      { buildCreateTradeTx: jest.fn().mockRejectedValue(new Error('could not load account: boom')) },
    );
    await expect(svc.buildCreateTradeTx('order-1', USER_ADDR)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(errSpy).toHaveBeenCalledWith('buildCreateTradeTx error:', expect.stringContaining('boom'));
  });

  it('buildConfirmReleaseTx: logs the real error and still throws ServiceUnavailableException', async () => {
    const { svc } = makeSvc(
      { status: 'FIAT_PAID' },
      { buildConfirmReleaseTx: jest.fn().mockRejectedValue(new Error('simulation failed: boom')) },
    );
    await expect(svc.buildConfirmReleaseTx('order-1', USER_ADDR)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(errSpy).toHaveBeenCalledWith('buildConfirmReleaseTx error:', expect.stringContaining('boom'));
  });

  it('buildRaiseDisputeTx: logs the real error and still throws ServiceUnavailableException', async () => {
    const { svc } = makeSvc(
      { status: 'FIAT_PAID' },
      { buildRaiseDisputeTx: jest.fn().mockRejectedValue(new Error('rpc down: boom')) },
    );
    await expect(svc.buildRaiseDisputeTx('order-1', USER_ADDR)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(errSpy).toHaveBeenCalledWith('buildRaiseDisputeTx error:', expect.stringContaining('boom'));
  });

  it('buildResolveTx: logs the real error and still throws ServiceUnavailableException', async () => {
    const { svc } = makeSvc(
      { status: 'DISPUTED' },
      { buildResolveTx: jest.fn().mockRejectedValue(new Error('rpc down: boom')) },
    );
    await expect(svc.buildResolveTx('order-1', 'GADMIN', 'release')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(errSpy).toHaveBeenCalledWith('buildResolveTx error:', expect.stringContaining('boom'));
  });

  it('buildConfirmReleaseTx: the client-facing error message is UNCHANGED (no internal detail leaked)', async () => {
    const { svc } = makeSvc(
      { status: 'FIAT_PAID' },
      { buildConfirmReleaseTx: jest.fn().mockRejectedValue(new Error('super secret internal detail')) },
    );
    await expect(svc.buildConfirmReleaseTx('order-1', USER_ADDR)).rejects.toThrow(
      'Stellar RPC unavailable, retry later',
    );
  });
});
