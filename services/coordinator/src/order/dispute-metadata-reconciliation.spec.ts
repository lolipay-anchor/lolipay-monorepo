import { ConflictException } from '@nestjs/common';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { OrderService } from './order.service';
import { makeUserReputationStub, orderStatusFor, orderTxFor } from './test-helpers';
import { IndexerService } from '../indexer/indexer.service';

const fakeStorage = {} as any;

describe('a filing and a signature can disagree, and both are kept', () => {
  const USER_ADDR = 'GUSER_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const LP_ADDR = 'GLP_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const PLATFORM = 'GPLATFORM';
  const FAKE_TRADE_ID = 'b'.repeat(64);
  const ORDER_ID = 'order-griefing-1';
  const CONFIG = { postSettleDisputeWindowSecs: 3600, requireProof: false };

  function whereMatches(where: Record<string, any>, current: Record<string, any>): boolean {
    for (const key of Object.keys(where)) {
      if (key === 'id') continue;
      const cond = where[key];
      if (cond && typeof cond === 'object' && 'in' in cond) {
        if (!(cond.in as any[]).includes(current[key])) return false;
      } else if (current[key] !== cond) {
        return false;
      }
    }
    return true;
  }

  function makeSharedPrisma(initial: Record<string, any>) {
    let current: Record<string, any> = { ...initial };
    const order = {
      findUnique: jest.fn().mockImplementation(({ where }: any) => {
        const matches = where?.id !== undefined ? where.id === current.id : where?.tradeId === current.tradeId;
        return Promise.resolve(matches ? { ...current, lp: { stellarAddress: LP_ADDR } } : null);
      }),
      update: jest.fn().mockImplementation(({ data }: any) => {
        current = { ...current, ...data };
        return Promise.resolve({ ...current });
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        if (!whereMatches(where, current)) return Promise.resolve({ count: 0 });
        current = { ...current, ...data };
        return Promise.resolve({ count: 1 });
      }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    const prisma = {
      order,
      quote: {},
      config: { upsert: jest.fn().mockResolvedValue({ ...CONFIG }) },
      lp: { findUnique: jest.fn() },
    } as any;
    return { prisma, getCurrent: () => current };
  }

  it('end-to-end: A fabricates and never signs, B signs on chain — A\'s account survives, B\'s signature is recorded beside it, and B still has no channel', async () => {
    const initialOrder = {
      id: ORDER_ID,
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
    };
    const { prisma, getCurrent } = makeSharedPrisma(initialOrder);

    const stellar = {
      buildRaiseDisputeTx: jest.fn().mockResolvedValue({ xdr: 'DISPUTE_XDR', networkPassphrase: 'p' }),
      getTradeStatus: jest.fn().mockResolvedValue(null),
      getTradeStatusStrict: jest.fn().mockResolvedValue(null),
    } as any;
    const matching = { pickLp: jest.fn() } as any;
    const cfg = { platformWallet: PLATFORM, escrowContractId: 'CTEST', escrowContractIdsExtra: [], adminAddresses: ['GADMIN'] } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;

    const orderService = new OrderService(prisma, stellar, matching, cfg, markets, notifications, fakeStorage, makeUserReputationStub(), orderStatusFor(prisma, stellar, cfg), orderTxFor(prisma, stellar, cfg));
    const userReputation = { recordDisputeLost: jest.fn().mockResolvedValue(undefined) } as any;
    const indexerService = new IndexerService(prisma, cfg, notifications, stellar, userReputation) as any;

    const aResult = await orderService.postDispute(
      ORDER_ID,
      USER_ADDR,
      'PAYMENT_NOT_RECEIVED',
      'the LP never paid me (this is a lie — A never actually raises a dispute on-chain)',
      undefined,
    );
    expect(aResult.order.dispute_by).toBe('user');
    expect(aResult.order.dispute_reason).toBe('PAYMENT_NOT_RECEIVED');
    expect(getCurrent().disputeBy).toBe('user');

    await expect(
      orderService.postDispute(ORDER_ID, LP_ADDR, 'WRONG_AMOUNT', 'the buyer never paid — real dispute', undefined),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(getCurrent().disputeReason).toBe('PAYMENT_NOT_RECEIVED');

    const disputedTopic = nativeToScVal('disputed', { type: 'symbol' });
    const tradeIdTopic = nativeToScVal(Buffer.from(FAKE_TRADE_ID, 'hex'));
    const eventValue = nativeToScVal({ by: LP_ADDR });
    const advanced = await indexerService.applyEvent({
      topic: [disputedTopic, tradeIdTopic],
      value: eventValue,
      contractId: 'CTEST',
    });
    expect(advanced).toBe(1);
    expect(getCurrent().status).toBe('DISPUTED');

    expect(getCurrent().disputeBy).toBe('user');
    expect(getCurrent().disputeReason).toBe('PAYMENT_NOT_RECEIVED');
    expect(getCurrent().onChainDisputedBy).toBe(LP_ADDR);

    await expect(
      orderService.postDispute(
        ORDER_ID,
        LP_ADDR,
        'WRONG_AMOUNT',
        'the buyer never paid — this is the real dispute',
        undefined,
      ),
    ).rejects.toThrow();

    const adminView = getCurrent();
    expect(adminView.disputeBy).toBe('user');
    expect(adminView.onChainDisputedBy).toBe(LP_ADDR);
    expect(adminView.disputeNote).toContain('this is a lie');
  });

  it('same-party double POST still 409 when a reason is already present (no reconciliation happened)', async () => {
    const initialOrder = {
      id: ORDER_ID,
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
      settledAt: null,
      disputeBy: 'user',
      disputeReason: 'PAYMENT_NOT_RECEIVED',
      disputeNote: 'genuinely mine',
      disputeEvidenceUrl: null,
      disputeAt: new Date(),
      resolution: null,
      payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
      rail: 'BANK',
      expiresAt: new Date(),
      createdAt: new Date(),
    };
    const { prisma } = makeSharedPrisma(initialOrder);
    const stellar = {
      buildRaiseDisputeTx: jest.fn().mockResolvedValue({ xdr: 'DISPUTE_XDR', networkPassphrase: 'p' }),
      getTradeStatus: jest.fn().mockResolvedValue(null),
    } as any;
    const matching = { pickLp: jest.fn() } as any;
    const cfg = { platformWallet: PLATFORM, escrowContractId: 'CTEST', escrowContractIdsExtra: [], adminAddresses: [] } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const orderService = new OrderService(prisma, stellar, matching, cfg, markets, notifications, fakeStorage, makeUserReputationStub(), orderStatusFor(prisma, stellar, cfg), orderTxFor(prisma, stellar, cfg));

    await expect(
      orderService.postDispute(ORDER_ID, USER_ADDR, 'WRONG_AMOUNT', 'trying again', undefined),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
