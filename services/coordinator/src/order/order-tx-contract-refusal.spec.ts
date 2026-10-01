import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { StellarReadService } from '../stellar/stellar-read.service';
import { OrderTxService } from './order-tx.service';
import { orderTxFor } from './test-helpers';

const USER_ADDR = 'GUSER';
const LP_ADDR = 'GLP';
const PLATFORM = 'GPLATFORM';
const TRADE_ID = 'a'.repeat(64);
const CONTRACT_ID = 'CTEST';
const INVALID_STATE_SENTENCE = 'the trade is not in a state that allows this call';

function invalidState(): Error {
  return new Error(
    'simulation failed: HostError: Error(Contract, #9)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:CTEST, topics:[fn_call, confirm_and_release], data:Bytes(aaea78be)',
  );
}

function makeOrder(overrides: Partial<any> = {}): any {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'order-1',
    tradeId: TRADE_ID,
    contractId: CONTRACT_ID,
    userAddress: USER_ADDR,
    flow: 'TOP_UP',
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
    lp: { stellarAddress: LP_ADDR },
    payDeadline: BigInt(now + 1800),
    confirmDeadline: BigInt(now + 3600),
    disputeDeadline: BigInt(now + 7200),
    rail: 'QRIS',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    ...overrides,
  };
}

function makePrisma(order: any): any {
  return {
    order: {
      findUnique: jest.fn().mockResolvedValue({ ...order }),
      update: jest.fn().mockResolvedValue({ ...order }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([order]),
      count: jest.fn().mockResolvedValue(0),
    },
    config: { upsert: jest.fn().mockResolvedValue({ id: 1, requireProof: false }) },
    lp: { findUnique: jest.fn() },
  };
}

function makeMockStellar(overrides: any = {}): any {
  return {
    buildMarkFiatPaidTx: jest.fn(),
    buildCreateTradeTx: jest.fn(),
    buildConfirmReleaseTx: jest.fn(),
    buildRaiseDisputeTx: jest.fn(),
    buildResolveTx: jest.fn(),
    buildSlashTx: jest.fn(),
    readDisputeSigners: jest.fn().mockResolvedValue({ resolver: 'GADMIN', admin: 'GADMIN' }),
    getTradeStatus: jest.fn().mockResolvedValue(null),
    getTradeStatusStrict: jest.fn().mockResolvedValue(null),
    getSlashedSoFar: jest.fn().mockResolvedValue(0n),
    evictTradeStatus: jest.fn(),
    ...overrides,
  };
}

const CFG = { platformWallet: PLATFORM, escrowContractId: 'CENV', stakingContractId: 'CSTAKING' } as any;

function warnLinesNaming(warnSpy: jest.SpyInstance, fn: string): string[] {
  return warnSpy.mock.calls.map((c) => String(c[0])).filter((line) => line.includes(fn));
}

const ESCROW_BUILDERS: Array<[string, string, (svc: OrderTxService) => Promise<unknown>]> = [
  ['buildMarkFiatPaidTx', 'FUNDED', (svc) => svc.buildMarkFiatPaidTx('order-1', USER_ADDR)],
  ['buildCreateTradeTx', 'AWAITING_ONCHAIN', (svc) => svc.buildCreateTradeTx('order-1', LP_ADDR)],
  ['buildConfirmReleaseTx', 'FIAT_PAID', (svc) => svc.buildConfirmReleaseTx('order-1', LP_ADDR)],
  ['buildRaiseDisputeTx', 'FIAT_PAID', (svc) => svc.buildRaiseDisputeTx('order-1', USER_ADDR)],
  ['buildResolveTx', 'DISPUTED', (svc) => svc.buildResolveTx('order-1', 'GADMIN', 'release')],
];

describe('OrderTxService — a contract refusal is a warn carrying the order id, never a bare console.error', () => {
  let errSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it.each(ESCROW_BUILDERS)(
    '%s on Error(Contract, #9): 409 sentence unchanged, no console.error, one warn with the order id and the raw error, the trade evicted from the status cache',
    async (fn, status, call) => {
      const stellar = makeMockStellar({ [fn]: jest.fn().mockRejectedValue(invalidState()) });
      const svc = orderTxFor(makePrisma(makeOrder({ status })), stellar, CFG);

      const failure = await call(svc).then(
        () => null,
        (e: unknown) => e,
      );
      expect(failure).toBeInstanceOf(ConflictException);
      expect((failure as Error).message).toBe(INVALID_STATE_SENTENCE);

      expect(errSpy).not.toHaveBeenCalled();
      const lines = warnLinesNaming(warnSpy, fn);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('order-1');
      expect(lines[0]).toContain('Error(Contract, #9)');
      expect(stellar.evictTradeStatus).toHaveBeenCalledTimes(1);
      expect(stellar.evictTradeStatus).toHaveBeenCalledWith(CONTRACT_ID, TRADE_ID);
    },
  );

  it('a #9 on an order whose contractId is null evicts the status cache entry keyed by the configured escrow contract id and the trade id', async () => {
    const stellar = makeMockStellar({
      buildConfirmReleaseTx: jest.fn().mockRejectedValue(invalidState()),
    });
    const svc = orderTxFor(makePrisma(makeOrder({ contractId: null })), stellar, CFG);

    await expect(svc.buildConfirmReleaseTx('order-1', LP_ADDR)).rejects.toThrow(INVALID_STATE_SENTENCE);

    expect(stellar.evictTradeStatus).toHaveBeenCalledTimes(1);
    expect(stellar.evictTradeStatus).toHaveBeenCalledWith(CFG.escrowContractId, TRADE_ID);
  });

  it('a contract refusal that is not #9 warns with the order id but does not evict the status cache', async () => {
    const stellar = makeMockStellar({
      buildConfirmReleaseTx: jest.fn().mockRejectedValue(new Error('HostError: Error(Contract, #12)')),
    });
    const svc = orderTxFor(makePrisma(makeOrder()), stellar, CFG);

    await expect(svc.buildConfirmReleaseTx('order-1', LP_ADDR)).rejects.toThrow(
      'the caller is not authorised for this call',
    );

    expect(errSpy).not.toHaveBeenCalled();
    const lines = warnLinesNaming(warnSpy, 'buildConfirmReleaseTx');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('order-1');
    expect(stellar.evictTradeStatus).not.toHaveBeenCalled();
  });

  it('a failure that is not the contract talking keeps console.error, emits no warn and evicts nothing', async () => {
    const stellar = makeMockStellar({
      buildConfirmReleaseTx: jest.fn().mockRejectedValue(new Error('simulation failed: boom')),
    });
    const svc = orderTxFor(makePrisma(makeOrder()), stellar, CFG);

    await expect(svc.buildConfirmReleaseTx('order-1', LP_ADDR)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(errSpy).toHaveBeenCalledWith('buildConfirmReleaseTx error:', expect.stringContaining('boom'));
    expect(warnLinesNaming(warnSpy, 'buildConfirmReleaseTx')).toHaveLength(0);
    expect(stellar.evictTradeStatus).not.toHaveBeenCalled();
  });

  it('buildSlashTx on a staking-contract refusal warns with the order id, and a staking #9 never evicts the escrow status cache', async () => {
    const stellar = makeMockStellar({
      buildSlashTx: jest.fn().mockRejectedValue(new Error('HostError: Error(Contract, #9)')),
      getTradeStatusStrict: jest.fn().mockResolvedValue({
        status: 'RELEASED',
        settledAt: 0,
        liabilityEstablished: true,
        slashDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      }),
    });
    const order = makeOrder({
      flow: 'WITHDRAW',
      status: 'RELEASED',
      usdcAmount: BigInt('1000000000'),
      settledAt: new Date(Date.now() - 60_000),
      disputeAt: new Date(Date.now() - 30_000),
    });
    const svc = orderTxFor(makePrisma(order), stellar, CFG);

    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).rejects.toThrow('resolver');

    expect(errSpy).not.toHaveBeenCalled();
    const lines = warnLinesNaming(warnSpy, 'buildSlashTx');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('order-1');
    expect(stellar.evictTradeStatus).not.toHaveBeenCalled();
  });
});

describe('OrderTxService with a real StellarReadService — after a #9 refusal the next read of that trade reaches the chain', () => {
  let errSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('the pre-check is served from the cache, the contract refuses with #9, and the refetch simulates get_trade again', async () => {
    const stellar = new StellarReadService({
      rpcUrl: 'x',
      networkPassphrase: 'x',
      stakingContractId: 'C',
      escrowContractId: 'C',
    } as any);
    const simulateCall = jest.fn(async () => ({ status: 1 }));
    (stellar as any).simulateCall = simulateCall;
    (stellar as any).buildConfirmReleaseTx = jest.fn().mockRejectedValue(invalidState());
    const svc = orderTxFor(makePrisma(makeOrder()), stellar, CFG);

    await expect(stellar.getTradeStatus(CONTRACT_ID, TRADE_ID)).resolves.toEqual({
      status: 'FIAT_PAID',
      settledAt: 0,
    });
    expect(simulateCall).toHaveBeenCalledTimes(1);

    await expect(svc.buildConfirmReleaseTx('order-1', LP_ADDR)).rejects.toThrow(INVALID_STATE_SENTENCE);
    expect(simulateCall).toHaveBeenCalledTimes(1);

    await stellar.getTradeStatus(CONTRACT_ID, TRADE_ID);
    expect(simulateCall).toHaveBeenCalledTimes(2);
  });
});
