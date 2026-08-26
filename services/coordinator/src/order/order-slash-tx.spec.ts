import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { orderTxFor } from './test-helpers';
import { describeStakingError, describeContractError } from './contract-error';

describe('OrderTxService — the slash caller', () => {
  const USER_ADDR = 'GUSER';
  const LP_ADDR = 'GLP';
  const TRADE_ID = 'a'.repeat(64);

  function makeSvc(orderOverrides: Partial<any> = {}, stellarOverrides: any = {}) {
    const order = {
      id: 'order-1',
      tradeId: TRADE_ID,
      contractId: 'CTEST',
      userAddress: USER_ADDR,
      flow: 'WITHDRAW',
      status: 'RELEASED',
      usdcAmount: BigInt('1000000000'),
      lpWallet: LP_ADDR,
      lpId: 'lp1',
      lp: { stellarAddress: LP_ADDR },
      payDeadline: BigInt(1),
      confirmDeadline: BigInt(2),
      disputeDeadline: BigInt(3),
      createdAt: new Date(),
      settledAt: new Date(Date.now() - 60_000),
      disputeAt: new Date(Date.now() - 30_000),
      ...orderOverrides,
    };
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({ ...order }),
        update: jest.fn().mockResolvedValue({ ...order }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      config: { upsert: jest.fn().mockResolvedValue({ id: 1 }) },
    } as any;
    const stellar = {
      buildSlashTx: jest.fn().mockResolvedValue({ xdr: 'XDR', networkPassphrase: 'NP' }),
      getSlashedSoFar: jest.fn().mockResolvedValue(0n),
      getTradeStatus: jest.fn().mockResolvedValue(null),
      getTradeStatusStrict: jest.fn().mockResolvedValue({
        status: 'RELEASED',
        settledAt: 0,
        liabilityEstablished: true,
        slashDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      }),
      ...stellarOverrides,
    } as any;
    const cfg = { platformWallet: 'GPLATFORM', escrowContractId: 'CENV' } as any;
    return { svc: orderTxFor(prisma, stellar, cfg), stellar };
  }

  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errSpy.mockRestore());

  it('builds a slash against the provider wallet, not the user', async () => {
    const { svc, stellar } = makeSvc();
    const out = await svc.buildSlashTx('order-1', 'GADMIN', BigInt('400000000'));
    expect(out).toEqual({ xdr: 'XDR', networkPassphrase: 'NP' });
    expect(stellar.buildSlashTx).toHaveBeenCalledWith(
      'GADMIN',
      LP_ADDR,
      TRADE_ID,
      BigInt('400000000'),
    );
  });

  it('refuses a settlement where the user, not the provider, ended up holding the money', async () => {
    const topUpReleased = makeSvc({ flow: 'TOP_UP', status: 'RELEASED' });
    await expect(
      topUpReleased.svc.buildSlashTx('order-1', 'GADMIN', BigInt('1')),
    ).rejects.toBeInstanceOf(ConflictException);

    const withdrawRefunded = makeSvc({ flow: 'WITHDRAW', status: 'REFUNDED' });
    await expect(
      withdrawRefunded.svc.buildSlashTx('order-1', 'GADMIN', BigInt('1')),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('accepts the two settlements where the provider is the one that defaulted', async () => {
    const topUpRefunded = makeSvc({ flow: 'TOP_UP', status: 'REFUNDED' });
    await expect(
      topUpRefunded.svc.buildSlashTx('order-1', 'GADMIN', BigInt('1')),
    ).resolves.toBeDefined();

    const withdrawReleased = makeSvc({ flow: 'WITHDRAW', status: 'RELEASED' });
    await expect(
      withdrawReleased.svc.buildSlashTx('order-1', 'GADMIN', BigInt('1')),
    ).resolves.toBeDefined();
  });

  it('refuses a trade that has not settled, because the escrow still holds the principal', async () => {
    for (const status of ['MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'CANCELLED', 'EXPIRED']) {
      const { svc } = makeSvc({ status });
      await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).rejects.toBeInstanceOf(
        ConflictException,
      );
    }
  });

  it('lets a still-disputed order through so the contract, not a stale row, gives the answer', async () => {
    const { svc } = makeSvc({ status: 'DISPUTED' });
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).resolves.toBeDefined();
  });

  it('never lets a slash ask for more than the trade was worth', async () => {
    const { svc } = makeSvc();
    await expect(
      svc.buildSlashTx('order-1', 'GADMIN', BigInt('1000000001')),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('0'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('-1'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses when the chain has established no liability, which is what the contract checks', async () => {
    const { svc } = makeSvc(
      {},
      {
        getTradeStatusStrict: jest.fn().mockResolvedValue({
          status: 'RELEASED',
          settledAt: 0,
          liabilityEstablished: false,
          slashDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
        }),
      },
    );
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses once the window closed well beyond any plausible clock drift', async () => {
    const { svc } = makeSvc(
      {},
      {
        getTradeStatusStrict: jest.fn().mockResolvedValue({
          status: 'RELEASED',
          settledAt: 0,
          liabilityEstablished: true,
          slashDeadline: BigInt(Math.floor(Date.now() / 1000) - 7200),
        }),
      },
    );
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('still builds when the host clock says the window just closed, because the ledger decides', async () => {
    const { svc } = makeSvc(
      {},
      {
        getTradeStatusStrict: jest.fn().mockResolvedValue({
          status: 'RELEASED',
          settledAt: 0,
          liabilityEstablished: true,
          slashDeadline: BigInt(Math.floor(Date.now() / 1000) - 60),
        }),
      },
    );
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).resolves.toBeDefined();
  });

  it('does not let a fast host clock refuse a window that is still open', async () => {
    const { svc } = makeSvc(
      {},
      {
        getTradeStatusStrict: jest.fn().mockResolvedValue({
          status: 'RELEASED',
          settledAt: 0,
          liabilityEstablished: true,
          slashDeadline: BigInt(Math.floor(Date.now() / 1000) - 600),
        }),
      },
    );
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).resolves.toBeDefined();
  });

  it('refuses when an exonerating verdict zeroed the window', async () => {
    const { svc } = makeSvc(
      {},
      {
        getTradeStatusStrict: jest.fn().mockResolvedValue({
          status: 'RELEASED',
          settledAt: 0,
          liabilityEstablished: true,
          slashDeadline: 0n,
        }),
      },
    );
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses rather than guessing when the chain cannot be read', async () => {
    const { svc } = makeSvc(
      {},
      { getTradeStatusStrict: jest.fn().mockRejectedValue(new Error('rpc down')) },
    );
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('reports the staking contract failure, not an RPC outage', async () => {
    const { svc } = makeSvc(
      {},
      { buildSlashTx: jest.fn().mockRejectedValue(new Error('... Error(Contract, #20)')) },
    );
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('falls back to an RPC outage only when the failure is not the contract talking', async () => {
    const { svc } = makeSvc(
      {},
      { buildSlashTx: jest.fn().mockRejectedValue(new Error('socket hang up')) },
    );
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('staking errors are not read with the escrow codebook', () => {
  it('gives different meanings to the same number on the two contracts', () => {
    const five = new Error('Error(Contract, #5)');
    expect(describeContractError(five)).toContain('no trade exists');
    expect(describeStakingError(five)).toContain('staked');
    expect(describeStakingError(five)).not.toContain('no trade exists');

    const nine = new Error('Error(Contract, #9)');
    expect(describeContractError(nine)).toContain('not in a state');
    expect(describeStakingError(nine)).toContain('resolver');
  });

  it('explains the two failures an operator will actually hit', () => {
    expect(describeStakingError(new Error('Error(Contract, #20)'))).toContain('resolve the dispute first');
    expect(describeStakingError(new Error('Error(Contract, #18)'))).toContain('window');
  });

  it('still says something useful for a code it does not know', () => {
    expect(describeStakingError(new Error('Error(Contract, #99)'))).toContain('#99');
  });
});

describe('OrderTxService — recovery already taken on chain', () => {
  const LP_ADDR = 'GLP';
  const TRADE_ID = 'a'.repeat(64);

  function makeSvc(slashed: bigint, stellarOverrides: any = {}) {
    const order = {
      id: 'order-1',
      tradeId: TRADE_ID,
      contractId: 'CTEST',
      userAddress: 'GUSER',
      flow: 'WITHDRAW',
      status: 'RELEASED',
      usdcAmount: BigInt('1000000000'),
      lpWallet: LP_ADDR,
      lpId: 'lp1',
      lp: { stellarAddress: LP_ADDR },
      payDeadline: BigInt(1),
      confirmDeadline: BigInt(2),
      disputeDeadline: BigInt(3),
      createdAt: new Date(),
      settledAt: new Date(Date.now() - 60_000),
      disputeAt: new Date(Date.now() - 30_000),
    };
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({ ...order }),
        update: jest.fn().mockResolvedValue({ ...order }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      config: { upsert: jest.fn().mockResolvedValue({ id: 1 }) },
    } as any;
    const stellar = {
      buildSlashTx: jest.fn().mockResolvedValue({ xdr: 'X', networkPassphrase: 'NP' }),
      getSlashedSoFar: jest.fn().mockResolvedValue(slashed),
      getTradeStatus: jest.fn().mockResolvedValue(null),
      getTradeStatusStrict: jest.fn().mockResolvedValue({
        status: 'RELEASED',
        settledAt: 0,
        liabilityEstablished: true,
        slashDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      }),
      ...stellarOverrides,
    } as any;
    const cfg = { platformWallet: 'GPLATFORM', escrowContractId: 'CENV' } as any;
    return { svc: orderTxFor(prisma, stellar, cfg), stellar };
  }

  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errSpy.mockRestore());

  it('measures the ceiling against what is left, not against the trade value', async () => {
    const { svc } = makeSvc(BigInt('600000000'));
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('400000000'))).resolves.toBeDefined();
    await expect(
      svc.buildSlashTx('order-1', 'GADMIN', BigInt('400000001')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses outright once the trade has been recovered in full', async () => {
    const { svc } = makeSvc(BigInt('1000000000'));
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses rather than risk a double recovery when the running total cannot be read', async () => {
    const { svc } = makeSvc(0n, {
      getSlashedSoFar: jest.fn().mockRejectedValue(new Error('rpc down')),
    });
    await expect(svc.buildSlashTx('order-1', 'GADMIN', BigInt('1'))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('reports the remainder so an operator can see what is left', async () => {
    const { svc } = makeSvc(BigInt('250000000'));
    const st = await svc.slashState({ tradeId: TRADE_ID, usdcAmount: BigInt('1000000000') });
    expect(st.recovered).toBe(BigInt('250000000'));
    expect(st.remaining).toBe(BigInt('750000000'));
  });

  it('never reports a negative remainder even if the chain says more was taken', async () => {
    const { svc } = makeSvc(BigInt('1200000000'));
    const st = await svc.slashState({ tradeId: TRADE_ID, usdcAmount: BigInt('1000000000') });
    expect(st.remaining).toBe(0n);
  });
});
