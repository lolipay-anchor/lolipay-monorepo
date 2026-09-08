import { Logger } from '@nestjs/common';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { IndexerService } from './indexer.service';

const TOPIC_TRADE_CREATED = 'AAAADwAAAA10cmFkZV9jcmVhdGVkAAAA';
const TOPIC_FIAT_PAID = 'AAAADwAAAAlmaWF0X3BhaWQAAAA=';
const TOPIC_TRADE_ID = 'AAAADQAAACC/wTx2FfH6j+s3LiPFn43hIOgX8EfX3HT57X89mqxugw==';
const VALUE_EMPTY = 'AAAAEQAAAAEAAAAA';

const eventLedger = () => {
  const seen = new Set<string>();
  return {
    createMany: jest.fn(async ({ data }: any) => {
      const rows = Array.isArray(data) ? data : [data];
      const fresh = rows.filter((r: any) => !seen.has(r.id));
      fresh.forEach((r: any) => seen.add(r.id));
      return { count: fresh.length };
    }),
  };
};

const TOPIC_RESOLVED = nativeToScVal('resolved', { type: 'symbol' });
const TOPIC_DISPUTED = nativeToScVal('disputed', { type: 'symbol' });
const TOPIC_RELEASED = nativeToScVal('released', { type: 'symbol' });
const TOPIC_REFUNDED = nativeToScVal('refunded', { type: 'symbol' });
const tradeIdTopic = (hex: string) => nativeToScVal(Buffer.from(hex, 'hex'));

const TRADE_ID_A = 'a'.repeat(64);

function boundTrade(order: any, overrides: Record<string, any> = {}) {
  const isTopUp = order.flow === 'TOP_UP';
  return {
    status: 'FUNDED',
    settledAt: 0,
    usdcAmount: order.usdcAmount,
    fiatAmount: order.fiatAmount,
    fiatCurrency: order.fiatCurrency,
    flow: isTopUp ? 0 : 1,
    usdcProvider: isTopUp ? order.lpWallet : order.userAddress,
    usdcRecipient: isTopUp ? order.userAddress : order.lpWallet,
    confirmer: isTopUp ? order.lpWallet : order.userAddress,
    platformWallet: order.platformWallet,
    lpWallet: order.lpWallet,
    platformFeeBps: order.platformFeeBps,
    lpFeeBps: order.lpFeeBps,
    payDeadline: order.payDeadline,
    confirmDeadline: order.confirmDeadline,
    disputeDeadline: order.disputeDeadline,
    ...overrides,
  };
}

describe('IndexerService.applyEvent', () => {
  function make(
    orderStatus = 'MATCHED',
    opts: {
      cfgOverrides?: any;
      stellarOverrides?: any;
      orderOverrides?: any;
      tradeId?: string;
      updateManyCount?: number;
    } = {},
  ) {
    const order = {
      id: 'ord-1',
      tradeId: opts.tradeId ?? TRADE_ID_A,
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'TOP_UP',
      status: orderStatus,
      usdcAmount: 100_0000000n,
      fiatAmount: 1_630_000n,
      fiatCurrency: 'IDR',
      platformFeeBps: 30,
      lpFeeBps: 120,
      platformWallet: 'GPLATFORM',
      payDeadline: 1_800n,
      confirmDeadline: 3_600n,
      disputeDeadline: 10_800n,
      ...opts.orderOverrides,
    };
    const prisma = {
      indexedEvent: eventLedger(),
      order: {
        findUnique: jest.fn().mockResolvedValue(order),
        update: jest.fn().mockResolvedValue(order),
        updateMany: jest.fn().mockResolvedValue({ count: opts.updateManyCount ?? 1 }),
      },
      adminAudit: { create: jest.fn().mockResolvedValue(undefined) },
    } as any;
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    const cfg = { rpcUrl: 'x', escrowContractId: 'CXXX', escrowContractIdsExtra: [], ...opts.cfgOverrides } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const stellar = {
      getTradeStatus: jest.fn(),
      getTradeStatusStrict: jest.fn().mockResolvedValue(boundTrade(order)),
      ...opts.stellarOverrides,
    } as any;
    const userReputation = { recordDisputeLost: jest.fn().mockResolvedValue(undefined) } as any;
    return {
      svc: new IndexerService(prisma, cfg, notifications, stellar, userReputation) as any,
      order,
      prisma,
      notifications,
      stellar,
      cfg,
      userReputation,
    };
  }

  it('decodes trade_created → FUNDED, advances a pre-FUNDED order, and notifies', async () => {
    const { svc, prisma, notifications } = make('MATCHED');
    const advanced = await svc.applyEvent({
      topic: [TOPIC_TRADE_CREATED, TOPIC_TRADE_ID],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.findUnique.mock.calls[0][0].where.tradeId).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.order.updateMany.mock.calls[0][0].data.status).toBe('FUNDED');
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ord-1' }),
      'FUNDED',
    );
  });

  it('REFUSES to advance when the on-chain trade is underfunded against the order (X0)', async () => {
    const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc, order, prisma, notifications, stellar } = make('MATCHED');
    stellar.getTradeStatusStrict.mockImplementation(async () =>
      boundTrade({ ...order, usdcAmount: 1n }),
    );

    const advanced = await svc.applyEvent({
      topic: [TOPIC_TRADE_CREATED, TOPIC_TRADE_ID],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });

    expect(advanced).toBe(0);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('REFUSING to bind'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('usdcAmount'));
    errSpy.mockRestore();
  });

  it('REFUSES to advance when the on-chain trade pays a wallet the order never matched (X0)', async () => {
    const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc, order, prisma, notifications, stellar } = make('MATCHED');
    stellar.getTradeStatusStrict.mockImplementation(async () =>
      boundTrade(order, { usdcRecipient: 'GATTACKER' }),
    );

    const advanced = await svc.applyEvent({
      topic: [TOPIC_TRADE_CREATED, TOPIC_TRADE_ID],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });

    expect(advanced).toBe(0);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('usdcRecipient'));
    errSpy.mockRestore();
  });

  it('fails closed when get_trade returns nothing for an unbound order', async () => {
    const { svc, prisma, notifications, stellar } = make('MATCHED');
    stellar.getTradeStatusStrict.mockResolvedValue(null);

    const advanced = await svc.applyEvent({
      topic: [TOPIC_TRADE_CREATED, TOPIC_TRADE_ID],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });

    expect(advanced).toBe(0);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('binds against the contract the event came from, not cfg.escrowContractId', async () => {
    const { svc, stellar } = make('MATCHED', { cfgOverrides: { escrowContractIdsExtra: ['CEXTRA'] } });

    await svc.applyEvent({
      topic: [TOPIC_TRADE_CREATED, TOPIC_TRADE_ID],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });

    expect(stellar.getTradeStatusStrict).toHaveBeenCalledWith('CXXX', TRADE_ID_A);
  });

  it('does not re-verify an order already bound on chain (FUNDED → FIAT_PAID)', async () => {
    const { svc, prisma, stellar } = make('FUNDED');

    const advanced = await svc.applyEvent({
      topic: [TOPIC_FIAT_PAID, TOPIC_TRADE_ID],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });

    expect(advanced).toBe(1);
    expect(stellar.getTradeStatusStrict).not.toHaveBeenCalled();
    expect(prisma.order.updateMany.mock.calls[0][0].data.status).toBe('FIAT_PAID');
  });

  it('keeps the transaction hash the chain reported, because SEP-24 cannot report completed without one', async () => {
    const { svc, prisma } = make('FIAT_PAID');
    const advanced = await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
      txHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801',
    } as any);
    expect(advanced).toBe(1);
    const written = prisma.order.updateMany.mock.calls[0][0].data;
    expect(written.status).toBe('RELEASED');
    expect(written.settlementTxHash).toBe(
      'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801',
    );
  });

  it('settles even when the chain reported no hash, rather than refusing the transition', async () => {
    const { svc, prisma } = make('FIAT_PAID');
    await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    } as any);
    const written = prisma.order.updateMany.mock.calls[0][0].data;
    expect(written.status).toBe('RELEASED');
    expect(written.settlementTxHash).toBeUndefined();
  });

  it('does NOT notify (and returns 0) when the order is already ahead — notify-gate fix', async () => {
    const { svc, prisma, notifications } = make('RELEASED');
    const advanced = await svc.applyEvent({
      topic: [TOPIC_FIAT_PAID, TOPIC_TRADE_ID],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(0);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('a trade_created event on an AWAITING_ONCHAIN WITHDRAW order DOES advance to FUNDED', async () => {
    const { svc, prisma, notifications } = make('AWAITING_ONCHAIN');
    const advanced = await svc.applyEvent({
      topic: [TOPIC_TRADE_CREATED, TOPIC_TRADE_ID],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: expect.arrayContaining(['AWAITING_ONCHAIN']) } },
      data: { status: 'FUNDED' },
    });
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'FUNDED');
  });

  it('a genuinely raced-away update (updateMany count 0 despite a stale local status match) does not notify', async () => {
    const { svc, prisma, notifications } = make('MATCHED', { updateManyCount: 0 });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_TRADE_CREATED, TOPIC_TRADE_ID],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(0);
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('ignores an undecodable / unknown event without touching the DB', async () => {
    const { svc, prisma, notifications } = make();
    const advanced = await svc.applyEvent({ topic: ['not-base64!!', TOPIC_TRADE_ID], value: '' });
    expect(advanced).toBe(0);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('decodes released → RELEASED and stamps settledAt (direct settlement, no dispute)', async () => {
    const { svc, prisma, notifications } = make('FIAT_PAID');
    const advanced = await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: expect.arrayContaining(['FIAT_PAID']) } },
      data: { status: 'RELEASED', settledAt: expect.any(Date) },
    });
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'RELEASED');
  });

  it('backfills settlementTxHash and notifies when another writer already set RELEASED, so a lost race loses neither', async () => {
    const { svc, prisma, notifications } = make('RELEASED');
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord-1',
      tradeId: TRADE_ID_A,
      status: 'RELEASED',
      settlementTxHash: null,
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'TOP_UP',
    });
    prisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
      txHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801',
    });
    expect(advanced).toBe(0);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: 'RELEASED', settlementTxHash: null },
      data: { settlementTxHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801' },
    });
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ord-1' }),
      'RELEASED',
    );
  });

  it('backfills when another writer wins the race WHILE the indexer awaits the chain, which is the common case', async () => {
    const { svc, prisma, notifications } = make('FIAT_PAID', { updateManyCount: 0 });
    prisma.order.findUnique
      .mockResolvedValueOnce({
        id: 'ord-1',
        tradeId: TRADE_ID_A,
        status: 'FIAT_PAID',
        settlementTxHash: null,
        userAddress: 'GUSER',
        lpWallet: 'GLP',
        flow: 'TOP_UP',
      })
      .mockResolvedValueOnce({
        id: 'ord-1',
        tradeId: TRADE_ID_A,
        status: 'RELEASED',
        settlementTxHash: null,
        userAddress: 'GUSER',
        lpWallet: 'GLP',
        flow: 'TOP_UP',
      });
    prisma.order.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
      txHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801',
    });
    expect(advanced).toBe(0);
    expect(prisma.order.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'ord-1', status: 'RELEASED', settlementTxHash: null },
      data: { settlementTxHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801' },
    });
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ord-1' }),
      'RELEASED',
    );
  });

  it('refuses to store a settlement hash that is not a transaction hash, whatever the RPC said', async () => {
    const { svc, prisma } = make('RELEASED');
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord-1',
      tradeId: TRADE_ID_A,
      status: 'RELEASED',
      settlementTxHash: null,
    });
    await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
      txHash: 'not-a-hash',
    });
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('does not touch or re-notify a RELEASED row that already carries a hash', async () => {
    const { svc, prisma, notifications } = make('RELEASED');
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord-1',
      tradeId: TRADE_ID_A,
      status: 'RELEASED',
      settlementTxHash: 'c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a1b2',
    });
    await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
      txHash: 'd4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a1b2c3',
    });
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('carries the chain-latched dispute deadline into the order on a direct settlement', async () => {
    const { svc, prisma, stellar } = make('FIAT_PAID');
    stellar.getTradeStatus.mockResolvedValue({
      status: 'RELEASED',
      settledAt: 1_700_000_000,
      postSettleDeadline: 1_700_003_600n,
    });
    await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    const { data } = prisma.order.updateMany.mock.calls[0][0];
    expect(data.postSettleDeadline).toBe(1_700_003_600n);
    expect(data.settledAt).toEqual(new Date(1_700_000_000 * 1000));
  });

  it('does not persist a zero deadline, which only ever means not yet settled', async () => {
    const { svc, prisma, stellar } = make('FIAT_PAID');
    stellar.getTradeStatus.mockResolvedValue({
      status: 'RELEASED',
      settledAt: 1_700_000_000,
      postSettleDeadline: 0n,
    });
    await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    const { data } = prisma.order.updateMany.mock.calls[0][0];
    expect('postSettleDeadline' in data).toBe(false);
  });

  it('leaves the latched deadline unset rather than inventing one when the chain read fails', async () => {
    const { svc, prisma, stellar } = make('FIAT_PAID');
    stellar.getTradeStatus.mockRejectedValue(new Error('rpc down'));
    await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    const { data } = prisma.order.updateMany.mock.calls[0][0];
    expect('postSettleDeadline' in data).toBe(false);
  });

  it('a resolved settlement does not persist a zero deadline either', async () => {
    const { svc, prisma, stellar } = make('DISPUTED');
    stellar.getTradeStatus.mockResolvedValue({
      status: 'RELEASED',
      settledAt: 1_700_000_500,
      postSettleDeadline: 0n,
    });
    await svc.applyEvent({
      id: 'ev-442',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ released: true, post_settle: false }),
      contractId: 'CXXX',
    });
    const { data } = prisma.order.updateMany.mock.calls[0][0];
    expect('postSettleDeadline' in data).toBe(false);
  });

  it('a dispute resolved into a settlement latches its deadline too', async () => {
    const { svc, prisma, stellar } = make('DISPUTED');
    stellar.getTradeStatus.mockResolvedValue({
      status: 'RELEASED',
      settledAt: 1_700_000_500,
      postSettleDeadline: 1_700_004_100n,
    });
    await svc.applyEvent({
      id: 'ev-458',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ released: true, post_settle: false }),
      contractId: 'CXXX',
    });
    const { data } = prisma.order.updateMany.mock.calls[0][0];
    expect(data.postSettleDeadline).toBe(1_700_004_100n);
  });

  it('decodes refunded → REFUNDED and stamps settledAt (direct settlement, no dispute)', async () => {
    const { svc, prisma, notifications } = make('FUNDED');
    const advanced = await svc.applyEvent({
      topic: [TOPIC_REFUNDED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: expect.arrayContaining(['FUNDED']) } },
      data: { status: 'REFUNDED', settledAt: expect.any(Date) },
    });
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'REFUNDED');
  });

  it('trade_created (FUNDED target) never touches settledAt', async () => {
    const { svc, prisma } = make('MATCHED');
    await svc.applyEvent({
      topic: [TOPIC_TRADE_CREATED, TOPIC_TRADE_ID],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: expect.arrayContaining(['MATCHED']) } },
      data: { status: 'FUNDED' },
    });
  });
});

describe('IndexerService.contractIdsToWatch (Phase 5A multi-contract)', () => {
  it('watches only the current contract when no extras are configured', () => {
    const svc = new IndexerService(
      {} as any,
      { escrowContractId: 'C1', escrowContractIdsExtra: [] } as any,
      {} as any,
      {} as any,
      {} as any,
    ) as any;
    expect(svc.contractIdsToWatch()).toEqual(['C1']);
  });

  it('watches the current contract plus retired ones, deduped', () => {
    const svc = new IndexerService(
      {} as any,
      { escrowContractId: 'C1', escrowContractIdsExtra: ['C2', 'C1'] } as any,
      {} as any,
      {} as any,
      {} as any,
    ) as any;
    expect(svc.contractIdsToWatch()).toEqual(['C1', 'C2']);
  });
});

describe('IndexerService.applyEvent — resolved (post-settlement, Phase 5A)', () => {
  function make(orderStatus: string, opts: Parameters<typeof makeBase>[1] = {}) {
    return makeBase(orderStatus, opts);
  }

  it('will not let a squatted trade drag a cancelled order back onto the books', async () => {
    const { svc, prisma } = make('CANCELLED', {
      stellarOverrides: {
        getTradeStatusStrict: jest.fn().mockResolvedValue({
          status: 'FUNDED',
          settledAt: 0,
          usdcAmount: 1n,
          fiatAmount: 1n,
          fiatCurrency: 'IDR',
          flow: 0,
          usdcProvider: 'GATTACKER',
          usdcRecipient: 'GATTACKER',
          confirmer: 'GATTACKER',
          platformWallet: 'GPLATFORM',
          lpWallet: 'GATTACKER',
          platformFeeBps: 30,
          lpFeeBps: 120,
          payDeadline: 1n,
          confirmDeadline: 2n,
          disputeDeadline: 3n,
        }),
      },
    });
    const value = nativeToScVal({ released: true, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-549',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });

    expect(advanced).toBe(0);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('carries the resolve transaction hash onto a resolver-released order, which never sees a released event', async () => {
    const { svc, prisma } = make('DISPUTED');
    const advanced = await svc.applyEvent({
      id: 'ev-561',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ released: true, post_settle: false }),
      contractId: 'CXXX',
      txHash: 'b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a1',
    });
    expect(advanced).toBe(1);
    const { data } = prisma.order.updateMany.mock.calls[0][0];
    expect(data.status).toBe('RELEASED');
    expect(data.settlementTxHash).toBe('b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a1');
  });

  it('leaves the original settlement hash alone on a post-settlement verdict, whose transaction is not the settlement', async () => {
    const { svc, prisma } = make('RELEASED', {
      stellarOverrides: {
        getTradeStatusStrict: jest.fn().mockResolvedValue({
          status: 'RELEASED',
          liabilityEstablished: true,
          slashDeadline: 1_800_000_000n,
        }),
      },
    });
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord-1',
      tradeId: TRADE_ID_A,
      status: 'RELEASED',
      settlementTxHash: 'the-settlement',
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'TOP_UP',
    });
    const advanced = await svc.applyEvent({
      id: 'ev-592',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ released: true, post_settle: true }),
      contractId: 'CXXX',
      txHash: 'b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a1',
    });
    expect(advanced).toBe(1);
    const statusWrites = prisma.order.updateMany.mock.calls.filter((c: any) => 'status' in c[0].data);
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0][0].data).not.toHaveProperty('settlementTxHash');
  });

  it('records the verdict and the hash when a client poll advanced the row before the resolved event landed', async () => {
    const { svc, prisma } = make('RELEASED');
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord-1',
      tradeId: TRADE_ID_A,
      status: 'RELEASED',
      resolution: null,
      settlementTxHash: null,
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'TOP_UP',
    });
    const advanced = await svc.applyEvent({
      id: 'ev-616',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ released: true, post_settle: false }),
      contractId: 'CXXX',
      txHash: 'B2C3D4E5F60718293A4B5C6D7E8F901A2B3C4D5E6F708192A3B4C5D6E7F801A1',
    });
    expect(advanced).toBe(1);
    const { where, data } = prisma.order.updateMany.mock.calls[0][0];
    expect(where.OR).toEqual(expect.arrayContaining([{ status: 'RELEASED', resolution: null }]));
    expect(data.resolution).toBe('released');
    expect(data.settlementTxHash).toBe('b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a1');
  });

  it('records the verdict on a resolver refund, whose Refunded event has already advanced the row', async () => {
    const { svc, prisma } = make('REFUNDED');
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'ord-1',
      tradeId: TRADE_ID_A,
      status: 'REFUNDED',
      resolution: null,
      settlementTxHash: 'e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a1b2c3d4',
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'TOP_UP',
    });
    const advanced = await svc.applyEvent({
      id: 'ev-641',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ released: false, post_settle: false }),
      contractId: 'CXXX',
      txHash: 'e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801a1b2c3d4',
    });
    expect(advanced).toBe(1);
    const { where, data } = prisma.order.updateMany.mock.calls[0][0];
    expect(where.OR).toEqual(expect.arrayContaining([{ status: 'REFUNDED', resolution: null }]));
    expect(data.resolution).toBe('refunded');
  });

  it('records what the resolver ruled, not how the trade had already settled', async () => {
    const { svc, prisma } = make('DISPUTED', {
      flow: 'TOP_UP',
      stellarOverrides: {
        getTradeStatusStrict: jest.fn().mockResolvedValue({
          status: 'RELEASED',
          liabilityEstablished: true,
          slashDeadline: 1_800_000_000n,
        }),
      },
    });
    const value = nativeToScVal({ released: false, post_settle: true });
    await svc.applyEvent({
      id: 'ev-665',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });

    const data = (prisma.order.updateMany as jest.Mock).mock.calls[0][0].data;
    expect(data.status).toBe('RELEASED');
    expect(data.resolution).toBe('refunded');
  });

  it('lands a verdict on a row the outage left far behind the chain', async () => {
    const { svc, prisma } = make('FIAT_PAID', {
      stellarOverrides: {
        getTradeStatusStrict: jest.fn().mockResolvedValue({
          status: 'RELEASED',
          liabilityEstablished: true,
          slashDeadline: 1_800_000_000n,
        }),
      },
    });
    const value = nativeToScVal({ released: false, post_settle: true });
    await svc.applyEvent({
      id: 'ev-687',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });

    const call = (prisma.order.updateMany as jest.Mock).mock.calls[0][0];
    expect(call.where).toEqual({ id: 'ord-1' });
    expect(prisma.indexedEvent.createMany).toHaveBeenCalledWith({ data: [{ id: 'ev-687' }], skipDuplicates: true });
  });

  it('records a post-settlement verdict even when the dispute before it was never indexed', async () => {
    const { svc, prisma } = make('RELEASED', {
      stellarOverrides: {
        getTradeStatusStrict: jest.fn().mockResolvedValue({
          status: 'RELEASED',
          liabilityEstablished: true,
          slashDeadline: 1_800_000_000n,
        }),
      },
    });
    const value = nativeToScVal({ released: false, post_settle: true });
    await svc.applyEvent({
      id: 'ev-708',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });

    const call = (prisma.order.updateMany as jest.Mock).mock.calls[0][0];
    expect(call.data).toEqual(
      expect.objectContaining({ liabilityEstablished: true, slashDeadline: 1_800_000_000n }),
    );
  });

  it('will still heal an order that was cancelled after its trade had reached the chain', async () => {
    const { svc, prisma } = make('CANCELLED');
    const value = nativeToScVal({ released: false, post_settle: false });
    await svc.applyEvent({
      id: 'ev-723',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    const where = (prisma.order.updateMany as jest.Mock).mock.calls[0][0].where;
    expect(where.OR[0].status.in).toContain('CANCELLED');
  });

  it('post_settle=false (normal dispute resolve): advances DISPUTED → RELEASED via the ordinary monotonic path', async () => {
    const { svc, prisma, notifications, stellar } = make('DISPUTED');
    const value = nativeToScVal({ released: true, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-735',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', OR: expect.arrayContaining([{ status: { in: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'DISPUTED', 'EXPIRED', 'CANCELLED'] }, resolution: null }]) },
      data: { status: 'RELEASED', settledAt: expect.any(Date), resolution: 'released' },
    });
    expect(prisma.order.update).not.toHaveBeenCalled();

    expect(stellar.getTradeStatus).toHaveBeenCalledWith('CXXX', TRADE_ID_A);
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'RELEASED');
  });

  it('OLD-contract event with NO post_settle key at all: treated as post_settle=false (graceful default)', async () => {
    const { svc, prisma, stellar } = make('DISPUTED');
    const value = nativeToScVal({ released: false });
    const advanced = await svc.applyEvent({
      id: 'ev-754',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', OR: expect.arrayContaining([{ status: { in: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'DISPUTED', 'EXPIRED', 'CANCELLED'] }, resolution: null }]) },
      data: { status: 'REFUNDED', settledAt: expect.any(Date), resolution: 'refunded' },
    });
    expect(stellar.getTradeStatus).toHaveBeenCalledWith('CXXX', TRADE_ID_A);
  });

  it('replayed resolved event on an already-terminal (RELEASED) order: guarded updateMany no-ops, no duplicate notify', async () => {
    const { svc, prisma, notifications, stellar } = make('RELEASED', { updateManyCount: 0 });
    const value = nativeToScVal({ released: true, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-770',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(0);
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();

    expect(stellar.getTradeStatus).toHaveBeenCalledWith('CXXX', TRADE_ID_A);
  });

  it('post_settle=true: reads on-chain status via the EVENT\'s own contract id (not cfg.escrowContractId) and bypasses the monotonic guard DISPUTED→RELEASED', async () => {
    const { svc, prisma, notifications, stellar } = make('DISPUTED', {
      cfgOverrides: { escrowContractId: 'CCFGDEFAULT' },
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'RELEASED' }) },
      orderContractId: 'CEVENTCONTRACT',
    });

    const value = nativeToScVal({ released: false, post_settle: true });
    const advanced = await svc.applyEvent({
      id: 'ev-789',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CEVENTCONTRACT',
    });
    expect(advanced).toBe(1);
    expect(stellar.getTradeStatusStrict).toHaveBeenCalledWith('CEVENTCONTRACT', TRADE_ID_A);

    expect(stellar.getTradeStatusStrict).toHaveBeenCalledTimes(1);

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1' },
      data: { status: 'RELEASED', resolution: 'refunded' },
    });
    expect(prisma.indexedEvent.createMany).toHaveBeenCalledWith({ data: [{ id: 'ev-789' }], skipDuplicates: true });
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'RELEASED');
  });

  it('post_settle=true, order already NOT DISPUTED (re-seen event / already reconciled): updateMany no-ops, no notify', async () => {
    const { svc, prisma, notifications, stellar } = make('DISPUTED', {
      updateManyCount: 0,
      stellarOverrides: { getTradeStatus: jest.fn().mockResolvedValue({ status: 'REFUNDED' }) },
      orderContractId: 'CEVENTCONTRACT',
    });
    const value = nativeToScVal({ released: false, post_settle: true });
    const advanced = await svc.applyEvent({
      id: 'ev-814',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CEVENTCONTRACT',
    });
    expect(advanced).toBe(0);
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('post_settle=true, on-chain read fails: throws so the batch replays instead of losing the event', async () => {
    const { svc, prisma, notifications } = make('DISPUTED', {
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockRejectedValue(new Error('rpc down')) },
      orderContractId: 'CEVENTCONTRACT',
    });
    const value = nativeToScVal({ released: true, post_settle: true });
    await expect(
      svc.applyEvent({
        id: 'ev-830',
        topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
        value,
        contractId: 'CEVENTCONTRACT',
      }),
    ).rejects.toThrow('rpc down');
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it.each(['FUNDED', 'DISPUTED', 'FIAT_PAID'])(
    'post_settle=true, on-chain status is not a terminal status (%s): hard no-op',
    async (onChainStatus) => {
      const { svc, prisma, notifications, stellar } = make('DISPUTED', {
        stellarOverrides: { getTradeStatus: jest.fn().mockResolvedValue({ status: onChainStatus }) },
        orderContractId: 'CEVENTCONTRACT',
      });
      const value = nativeToScVal({ released: true, post_settle: true });
      const advanced = await svc.applyEvent({
        id: 'ev-848',
        topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
        value,
        contractId: 'CEVENTCONTRACT',
      });
      expect(advanced).toBe(0);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
    },
  );
});

describe('IndexerService.applyEvent — settledAt uses on-chain settled_at (Analytics-accuracy fix)', () => {
  const ON_CHAIN_SECS = 1_700_000_000;

  it('direct released event: settledAt comes from the on-chain trade.settledAt (converted from unix-seconds)', async () => {
    const { svc, prisma, stellar } = makeBase('FIAT_PAID', {
      stellarOverrides: {
        getTradeStatus: jest.fn().mockResolvedValue({ status: 'RELEASED', settledAt: ON_CHAIN_SECS }),
      },
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(stellar.getTradeStatus).toHaveBeenCalledWith('CXXX', TRADE_ID_A);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: expect.arrayContaining(['FIAT_PAID']) } },
      data: { status: 'RELEASED', settledAt: new Date(ON_CHAIN_SECS * 1000) },
    });
  });

  it('direct refunded event: settledAt comes from the on-chain trade.settledAt', async () => {
    const { svc, prisma } = makeBase('FUNDED', {
      stellarOverrides: {
        getTradeStatus: jest.fn().mockResolvedValue({ status: 'REFUNDED', settledAt: ON_CHAIN_SECS }),
      },
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_REFUNDED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: expect.arrayContaining(['FUNDED']) } },
      data: { status: 'REFUNDED', settledAt: new Date(ON_CHAIN_SECS * 1000) },
    });
  });

  it('direct released event: on-chain read THROWS — falls back to new Date(), RELEASED transition still happens (never blocked)', async () => {
    const { svc, prisma, notifications } = makeBase('FIAT_PAID', {
      stellarOverrides: { getTradeStatus: jest.fn().mockRejectedValue(new Error('rpc down')) },
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: expect.arrayContaining(['FIAT_PAID']) } },
      data: { status: 'RELEASED', settledAt: expect.any(Date) },
    });
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'RELEASED');
  });

  it('direct released event: on-chain read returns null (not found) — falls back to new Date()', async () => {
    const { svc, prisma } = makeBase('FIAT_PAID', {
      stellarOverrides: { getTradeStatus: jest.fn().mockResolvedValue(null) },
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: expect.arrayContaining(['FIAT_PAID']) } },
      data: { status: 'RELEASED', settledAt: expect.any(Date) },
    });
  });

  it('direct released event: on-chain settledAt is 0 (trade struct default, not yet snapshotted) — falls back to new Date()', async () => {
    const { svc, prisma } = makeBase('FIAT_PAID', {
      stellarOverrides: {
        getTradeStatus: jest.fn().mockResolvedValue({ status: 'RELEASED', settledAt: 0 }),
      },
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_RELEASED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: expect.arrayContaining(['FIAT_PAID']) } },
      data: { status: 'RELEASED', settledAt: expect.any(Date) },
    });
  });

  it('resolved event (post_settle=false, first-time dispute settlement): settledAt comes from the already-read on-chain trade', async () => {
    const { svc, prisma, stellar } = makeBase('DISPUTED', {
      stellarOverrides: {
        getTradeStatus: jest.fn().mockResolvedValue({ status: 'RELEASED', settledAt: ON_CHAIN_SECS }),
      },
    });
    const value = nativeToScVal({ released: true, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-958',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);

    expect(stellar.getTradeStatus).toHaveBeenCalledTimes(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', OR: expect.arrayContaining([{ status: { in: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'DISPUTED', 'EXPIRED', 'CANCELLED'] }, resolution: null }]) },
      data: { status: 'RELEASED', settledAt: new Date(ON_CHAIN_SECS * 1000), resolution: 'released' },
    });
  });

  it('resolved event (post_settle=false): on-chain read fails — falls back to new Date(), RELEASED transition still happens', async () => {
    const { svc, prisma, notifications } = makeBase('DISPUTED', {
      stellarOverrides: { getTradeStatus: jest.fn().mockRejectedValue(new Error('rpc down')) },
    });
    const value = nativeToScVal({ released: true, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-977',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', OR: expect.arrayContaining([{ status: { in: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'DISPUTED', 'EXPIRED', 'CANCELLED'] }, resolution: null }]) },
      data: { status: 'RELEASED', settledAt: expect.any(Date), resolution: 'released' },
    });
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'RELEASED');
  });
});

describe('IndexerService.applyEvent — resolved dispute-loss accrual (Phase 6 §10 Task 2, Decision #3)', () => {
  function make(orderStatus: string, opts: Parameters<typeof makeBase>[1] = {}) {
    return makeBase(orderStatus, opts);
  }

  it('TOP_UP resolved refunded → user lost the dispute: recordDisputeLost(userAddress) called once', async () => {
    const { svc, notifications, userReputation } = make('DISPUTED', { flow: 'TOP_UP' });
    const value = nativeToScVal({ released: false, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-999',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(userReputation.recordDisputeLost).toHaveBeenCalledTimes(1);
    expect(userReputation.recordDisputeLost).toHaveBeenCalledWith('GUSER', 'ord-1');
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'REFUNDED');
  });

  it('WITHDRAW resolved released → user lost the dispute: recordDisputeLost(userAddress) called once', async () => {
    const { svc, userReputation } = make('DISPUTED', { flow: 'WITHDRAW' });
    const value = nativeToScVal({ released: true, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-1013',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(userReputation.recordDisputeLost).toHaveBeenCalledTimes(1);
    expect(userReputation.recordDisputeLost).toHaveBeenCalledWith('GUSER', 'ord-1');
  });

  it('WITHDRAW resolved released → user lost the dispute: recordDisputeLost(userAddress) called once', async () => {
    const { svc, userReputation } = make('DISPUTED', { flow: 'WITHDRAW' });
    const value = nativeToScVal({ released: true, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-1026',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(userReputation.recordDisputeLost).toHaveBeenCalledTimes(1);
    expect(userReputation.recordDisputeLost).toHaveBeenCalledWith('GUSER', 'ord-1');
  });

  it('TOP_UP resolved released (LP lost, not the user) → recordDisputeLost is NOT called', async () => {
    const { svc, userReputation } = make('DISPUTED', { flow: 'TOP_UP' });
    const value = nativeToScVal({ released: true, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-1039',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(userReputation.recordDisputeLost).not.toHaveBeenCalled();
  });

  it('WITHDRAW resolved refunded (LP lost, not the user) → recordDisputeLost is NOT called', async () => {
    const { svc, userReputation } = make('DISPUTED', { flow: 'WITHDRAW' });
    const value = nativeToScVal({ released: false, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-1051',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(userReputation.recordDisputeLost).not.toHaveBeenCalled();
  });

  it('WITHDRAW resolved refunded (LP lost, not the user) → recordDisputeLost is NOT called', async () => {
    const { svc, userReputation } = make('DISPUTED', { flow: 'WITHDRAW' });
    const value = nativeToScVal({ released: false, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-1063',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(userReputation.recordDisputeLost).not.toHaveBeenCalled();
  });

  it('re-seen resolved event on an already-terminal order (guarded updateMany count 0): recordDisputeLost is NOT called again', async () => {
    const { svc, userReputation } = make('REFUNDED', { flow: 'TOP_UP', updateManyCount: 0 });
    const value = nativeToScVal({ released: false, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-1075',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(0);
    expect(userReputation.recordDisputeLost).not.toHaveBeenCalled();
  });

  it('re-seen post_settle resolved event (already reconciled, guarded updateMany count 0): recordDisputeLost is NOT called again', async () => {
    const { svc, userReputation, stellar } = make('DISPUTED', {
      flow: 'WITHDRAW',
      updateManyCount: 0,
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'RELEASED' }) },
      orderContractId: 'CEVENTCONTRACT',
    });
    const value = nativeToScVal({ released: true, post_settle: true });
    const advanced = await svc.applyEvent({
      id: 'ev-1092',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CEVENTCONTRACT',
    });
    expect(advanced).toBe(0);
    expect(stellar.getTradeStatusStrict).toHaveBeenCalled();
    expect(userReputation.recordDisputeLost).not.toHaveBeenCalled();
  });

  it('post-settle: a verdict that overturns a released WITHDRAW blames the LP, never the user who won', async () => {
    const { svc, userReputation, notifications } = make('DISPUTED', {
      flow: 'WITHDRAW',
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'RELEASED' }) },
      orderContractId: 'CEVENTCONTRACT',
    });
    const value = nativeToScVal({ released: false, post_settle: true });
    const advanced = await svc.applyEvent({
      id: 'ev-1109',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CEVENTCONTRACT',
    });
    expect(advanced).toBe(1);
    expect(userReputation.recordDisputeLost).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'RELEASED');
  });

  it('post-settle: a verdict that upholds a released WITHDRAW blames the user who lost it', async () => {
    const { svc, userReputation } = make('DISPUTED', {
      flow: 'WITHDRAW',
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'RELEASED' }) },
      orderContractId: 'CEVENTCONTRACT',
    });
    const value = nativeToScVal({ released: true, post_settle: true });
    await svc.applyEvent({
      id: 'ev-1126',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CEVENTCONTRACT',
    });
    expect(userReputation.recordDisputeLost).toHaveBeenCalledTimes(1);
    expect(userReputation.recordDisputeLost).toHaveBeenCalledWith('GUSER', 'ord-1');
  });

  it('post-settle: a verdict that overturns a refunded TOP_UP blames the LP, never the user who won', async () => {
    const { svc, userReputation } = make('DISPUTED', {
      flow: 'TOP_UP',
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'REFUNDED' }) },
      orderContractId: 'CEVENTCONTRACT',
    });
    const value = nativeToScVal({ released: true, post_settle: true });
    const advanced = await svc.applyEvent({
      id: 'ev-1142',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CEVENTCONTRACT',
    });
    expect(advanced).toBe(1);
    expect(userReputation.recordDisputeLost).not.toHaveBeenCalled();
  });

  it('post-settle: the status keeps the settlement direction, the resolution keeps the ruling, and the blame follows the ruling', async () => {
    const { svc, prisma, userReputation } = make('DISPUTED', {
      flow: 'TOP_UP',
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'REFUNDED' }) },
      orderContractId: 'CEVENTCONTRACT',
    });
    await svc.applyEvent({
      id: 'ev-1157',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ released: true, post_settle: true }),
      contractId: 'CEVENTCONTRACT',
    });
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1' },
      data: { status: 'REFUNDED', resolution: 'released' },
    });
    expect(prisma.indexedEvent.createMany).toHaveBeenCalledWith({ data: [{ id: 'ev-1157' }], skipDuplicates: true });
    expect(userReputation.recordDisputeLost).not.toHaveBeenCalled();
  });

  it('post-settle branch: TOP_UP + on-chain RELEASED → LP lost, recordDisputeLost NOT called', async () => {
    const { svc, userReputation } = make('DISPUTED', {
      flow: 'TOP_UP',
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'RELEASED' }) },
      orderContractId: 'CEVENTCONTRACT',
    });
    const value = nativeToScVal({ released: true, post_settle: true });
    const advanced = await svc.applyEvent({
      id: 'ev-1176',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CEVENTCONTRACT',
    });
    expect(advanced).toBe(1);
    expect(userReputation.recordDisputeLost).not.toHaveBeenCalled();
  });

  it('recordDisputeLost throwing does not prevent the order transition, notification, or advance count', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, prisma, notifications, userReputation } = make('DISPUTED', { flow: 'TOP_UP' });
    userReputation.recordDisputeLost.mockRejectedValue(new Error('db down'));
    const value = nativeToScVal({ released: false, post_settle: false });
    const advanced = await svc.applyEvent({
      id: 'ev-1190',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'REFUNDED');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('recordDisputeLost failed'));
    warnSpy.mockRestore();
  });
});

describe('IndexerService.applyEvent — disputed (post-settlement raise, Phase 5A)', () => {
  function make(orderStatus: string, opts: Parameters<typeof makeBase>[1] = {}) {
    return makeBase(orderStatus, opts);
  }

  it('normal forward path unaffected: FIAT_PAID → DISPUTED via the ordinary monotonic update', async () => {
    const { svc, prisma, notifications, stellar } = make('FIAT_PAID');
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal(null),
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'EXPIRED', 'CANCELLED'] } },
      data: { status: 'DISPUTED', disputeAt: expect.any(Date) },
    });
    expect(prisma.order.update).not.toHaveBeenCalled();

    expect(stellar.getTradeStatus).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'DISPUTED');
  });

  it('replayed disputed event on an already-DISPUTED order: guarded updateMany no-ops, no duplicate notify', async () => {
    const { svc, prisma, notifications, stellar } = make('DISPUTED', { updateManyCount: 0 });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal(null),
      contractId: 'CXXX',
    });
    expect(advanced).toBe(0);
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
    expect(stellar.getTradeStatus).not.toHaveBeenCalled();
  });

  it('genuine post-settle raise: RELEASED → DISPUTED bypasses the monotonic guard ONLY after on-chain confirms DISPUTED', async () => {
    const { svc, prisma, notifications, stellar } = make('RELEASED', {
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'DISPUTED' }) },
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal(null),
      contractId: 'CXXX',
    });
    expect(stellar.getTradeStatusStrict).toHaveBeenCalledWith('CXXX', TRADE_ID_A);
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: ['RELEASED', 'REFUNDED'] } },
      data: { status: 'DISPUTED', disputeAt: expect.any(Date) },
    });
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'DISPUTED');
  });

  it('genuine post-settle raise from REFUNDED also bypasses the monotonic guard after on-chain confirms DISPUTED', async () => {
    const { svc, prisma, notifications, stellar } = make('REFUNDED', {
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'DISPUTED' }) },
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal(null),
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: ['RELEASED', 'REFUNDED'] } },
      data: { status: 'DISPUTED', disputeAt: expect.any(Date) },
    });
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'DISPUTED');
  });

  it('post-settlement raise preserves the ORIGINAL disputeAt when the order was already disputed once before (disputeAt "if null")', async () => {
    const originalDisputeAt = new Date('2026-01-01T00:00:00.000Z');
    const { svc, prisma, notifications, stellar } = make('RELEASED', {
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'DISPUTED' }) },
    });

    prisma.order.findUnique.mockResolvedValue({
      id: 'ord-1',
      tradeId: TRADE_ID_A,
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'TOP_UP',
      status: 'RELEASED',
      disputeBy: 'user',
      disputeAt: originalDisputeAt,
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal(null),
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: ['RELEASED', 'REFUNDED'] } },
      data: { status: 'DISPUTED', disputeAt: originalDisputeAt },
    });
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'DISPUTED');
  });

  it('post-settlement raise re-seen (already back in DISPUTED elsewhere): updateMany no-ops, no duplicate notify', async () => {
    const { svc, prisma, notifications } = make('RELEASED', {
      updateManyCount: 0,
      stellarOverrides: { getTradeStatus: jest.fn().mockResolvedValue({ status: 'DISPUTED' }) },
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal(null),
      contractId: 'CXXX',
    });
    expect(advanced).toBe(0);
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('REPLAYED disputed event on a settled order: on-chain currently reads RELEASED (not DISPUTED) → no flip, no notification (audit LOW fix)', async () => {
    const { svc, prisma, notifications, stellar } = make('RELEASED', {
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'RELEASED' }) },
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal(null),
      contractId: 'CXXX',
    });
    expect(stellar.getTradeStatusStrict).toHaveBeenCalledWith('CXXX', TRADE_ID_A);
    expect(advanced).toBe(0);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('post-settle bypass fails closed when the on-chain read errors (RPC down)', async () => {
    const { svc, prisma, notifications, stellar } = make('RELEASED', {
      stellarOverrides: { getTradeStatus: jest.fn().mockRejectedValue(new Error('rpc down')) },
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal(null),
      contractId: 'CXXX',
    });
    expect(advanced).toBe(0);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });
});

describe('IndexerService.applyEvent — disputed metadata reconciliation (INERT-METADATA GRIEFING fix)', () => {
  function makeWithMetadata(orderOverrides: Record<string, any> = {}) {
    const order: Record<string, any> = {
      id: 'ord-1',
      tradeId: TRADE_ID_A,
      contractId: null,
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'WITHDRAW',
      status: 'FIAT_PAID',
      disputeAt: null,
      disputeBy: null,
      disputeReason: null,
      disputeNote: null,
      disputeEvidenceUrl: null,
      resolverDisputed: false,
      ...orderOverrides,
    };
    const prisma = {
      indexedEvent: eventLedger(),
      order: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...order })),
        update: jest.fn(),
        updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
          if ('status' in where) {
            const matches =
              typeof where.status === 'string' ? order.status === where.status : (where.status?.in ?? []).includes(order.status);
            if (!matches) return Promise.resolve({ count: 0 });
            Object.assign(order, data);
            return Promise.resolve({ count: 1 });
          }
          if ('disputeBy' in where) {
            if (order.disputeBy !== where.disputeBy) return Promise.resolve({ count: 0 });
            Object.assign(order, data);
            return Promise.resolve({ count: 1 });
          }
          if ('resolverDisputed' in where) {
            if (order.resolverDisputed !== where.resolverDisputed) {
              return Promise.resolve({ count: 0 });
            }
            Object.assign(order, data);
            return Promise.resolve({ count: 1 });
          }
          if (Object.keys(where).length === 1 && 'id' in where) {
            Object.assign(order, data);
            return Promise.resolve({ count: 1 });
          }
          return Promise.resolve({ count: 0 });
        }),
      },
    } as any;
    prisma.adminAudit = { create: jest.fn().mockResolvedValue(undefined) };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    const cfg = { rpcUrl: 'x', escrowContractId: 'CXXX', escrowContractIdsExtra: [] } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const stellar = { getTradeStatus: jest.fn(), getTradeStatusStrict: jest.fn() } as any;
    const userReputation = { recordDisputeLost: jest.fn().mockResolvedValue(undefined) } as any;
    return {
      svc: new IndexerService(prisma, cfg, notifications, stellar, userReputation) as any,
      prisma,
      notifications,
      stellar,
      order,
      userReputation,
    };
  }

  it('records who signed on chain and keeps the filing, rather than destroying evidence it cannot replace', async () => {
    const { svc, order } = makeWithMetadata({
      disputeBy: 'user',
      disputeReason: 'PAYMENT_NOT_RECEIVED',
      disputeNote: 'fabricated by A, who never signed',
      disputeEvidenceUrl: 'evidence/ord-1-user.jpg',
    });
    const value = nativeToScVal({ by: 'GLP' });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(order.status).toBe('DISPUTED');
    expect(order.onChainDisputedBy).toBe('GLP');
    expect(order.disputeBy).toBe('user');
    expect(order.disputeReason).toBe('PAYMENT_NOT_RECEIVED');
    expect(order.disputeNote).toBe('fabricated by A, who never signed');
    expect(order.disputeEvidenceUrl).toBe('evidence/ord-1-user.jpg');
  });

  it('stores the address the chain reported, not a role this server guessed at', async () => {
    const { svc, order } = makeWithMetadata({ disputeBy: null });
    await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ by: 'GSOMEONEELSE' }),
      contractId: 'CXXX',
    });
    expect(order.onChainDisputedBy).toBe('GSOMEONEELSE');
  });

  it('forward path: on-chain disputer MATCHES stored metadata -> no reconciliation, reason/note/evidence untouched', async () => {
    const { svc, order } = makeWithMetadata({
      disputeBy: 'user',
      disputeReason: 'PAYMENT_NOT_RECEIVED',
      disputeNote: 'genuinely mine',
      disputeEvidenceUrl: 'evidence/ord-1-user.jpg',
    });
    const value = nativeToScVal({ by: 'GUSER' });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(order.disputeBy).toBe('user');
    expect(order.disputeReason).toBe('PAYMENT_NOT_RECEIVED');
    expect(order.disputeNote).toBe('genuinely mine');
    expect(order.disputeEvidenceUrl).toBe('evidence/ord-1-user.jpg');
  });

  it('records the on-chain signer even when nobody has filed anything off chain', async () => {
    const { svc, order } = makeWithMetadata({ disputeBy: null });
    await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ by: 'GLP' }),
      contractId: 'CXXX',
    });
    expect(order.onChainDisputedBy).toBe('GLP');
    expect(order.disputeBy).toBeNull();
    expect(order.disputeReason ?? null).toBeNull();
  });

  it('a disputer this server cannot place is recorded as an escalation, not as a party', async () => {
    const { svc, order } = makeWithMetadata({ disputeBy: null });
    const value = nativeToScVal({ by: 'GSOMEONE_ELSE_ENTIRELY' });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(order.resolverDisputed).toBe(true);
    expect(order.disputeBy).toBeNull();
  });

  it('an undecodable/absent `by` (legacy event shape) is a fail-closed no-op — metadata is left exactly as filed', async () => {
    const { svc, prisma, order } = makeWithMetadata({
      disputeBy: 'user',
      disputeReason: 'PAYMENT_NOT_RECEIVED',
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal(null),
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(order.disputeBy).toBe('user');
    expect(order.disputeReason).toBe('PAYMENT_NOT_RECEIVED');

    expect(prisma.order.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a resolver dispute of its own is recorded without destroying the party's filing", async () => {
    const { svc, order } = makeWithMetadata({
      disputeBy: 'user',
      disputeReason: 'PAYMENT_NOT_RECEIVED',
    });
    const value = nativeToScVal({ by: 'GSOMEONE_ELSE_ENTIRELY' });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(order.resolverDisputed).toBe(true);
    expect(order.disputeBy).toBe('user');
    expect(order.disputeReason).toBe('PAYMENT_NOT_RECEIVED');
  });

  it('records the on-chain signer on the post-settlement path too, without touching the filing', async () => {
    const { svc, order, stellar } = makeWithMetadata({
      status: 'RELEASED',
      disputeBy: 'lp',
      disputeReason: 'WRONG_AMOUNT',
      disputeNote: 'fabricated by the LP, who never signed',
      disputeEvidenceUrl: 'evidence/ord-1-lp.jpg',
    });
    stellar.getTradeStatusStrict.mockResolvedValue({ status: 'DISPUTED' });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ by: 'GUSER' }),
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(order.onChainDisputedBy).toBe('GUSER');
    expect(order.disputeBy).toBe('lp');
    expect(order.disputeReason).toBe('WRONG_AMOUNT');
    expect(order.disputeEvidenceUrl).toBe('evidence/ord-1-lp.jpg');
  });
});

describe('IndexerService.applyEvent — contractId guard (defense-in-depth)', () => {
  it("event from a DIFFERENT contract than the order's own contractId is skipped with a warn log, no DB write", async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, prisma, notifications } = makeBase('MATCHED', { orderContractId: 'CORDER_OWN' });

    const advanced = await svc.applyEvent({
      topic: [TOPIC_TRADE_CREATED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CSOME_OTHER_CONTRACT',
    });

    expect(advanced).toBe(0);
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('contract mismatch'));
    warnSpy.mockRestore();
  });

  it('event contractId matching the order\'s own contractId (not cfg.escrowContractId) is applied normally', async () => {
    const { svc, prisma } = makeBase('MATCHED', {
      orderContractId: 'CORDER_OWN',
      cfgOverrides: { escrowContractId: 'CCFGDEFAULT' },
    });

    const advanced = await svc.applyEvent({
      topic: [TOPIC_TRADE_CREATED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
      contractId: 'CORDER_OWN',
    });

    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: { in: expect.arrayContaining(['MATCHED']) } },
      data: { status: 'FUNDED' },
    });
  });

  it('event with NO contractId at all (missing/malformed shape) is skipped with a warn log, no DB write (fail-closed)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, prisma, notifications } = makeBase('MATCHED', { orderContractId: 'CORDER_OWN' });

    const advanced = await svc.applyEvent({
      topic: [TOPIC_TRADE_CREATED, tradeIdTopic(TRADE_ID_A)],
      value: VALUE_EMPTY,
    });

    expect(advanced).toBe(0);
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing contractId'));
    warnSpy.mockRestore();
  });
});

describe('IndexerService.applyEvent — disputed/resolved split-replay window (self-heal)', () => {
  it('disputed processed without its paired resolved in the same batch leaves DISPUTED; a later resolved batch settles it', async () => {
    const order = {
      id: 'ord-1',
      tradeId: TRADE_ID_A,
      contractId: 'CEVENTCONTRACT',
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'TOP_UP',
      status: 'RELEASED',
    };
    const prisma = {
      indexedEvent: eventLedger(),
      order: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(order)),
        update: jest.fn().mockResolvedValue(order),

        updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
          const matches =
            where.status === undefined
              ? true
              : typeof where.status === 'string'
                ? order.status === where.status
                : (where.status?.in ?? []).includes(order.status);
          if (!matches) return Promise.resolve({ count: 0 });
          Object.assign(order, data);
          return Promise.resolve({ count: 1 });
        }),
      },
    } as any;
    prisma.adminAudit = { create: jest.fn().mockResolvedValue(undefined) };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    const cfg = { rpcUrl: 'x', escrowContractId: 'CEVENTCONTRACT', escrowContractIdsExtra: [] } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;

    const stellar = {
      getTradeStatusStrict: jest
        .fn()
        .mockResolvedValueOnce({ status: 'DISPUTED' })
        .mockResolvedValue({ status: 'RELEASED' }),
    } as any;
    const userReputation = { recordDisputeLost: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new IndexerService(prisma, cfg, notifications, stellar, userReputation) as any;

    const advancedDisputed = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal(null),
      contractId: 'CEVENTCONTRACT',
    });
    expect(advancedDisputed).toBe(1);
    expect(order.status).toBe('DISPUTED');
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'DISPUTED');

    const value = nativeToScVal({ released: true, post_settle: true });
    const advancedResolved = await svc.applyEvent({
      id: 'ev-1657',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value,
      contractId: 'CEVENTCONTRACT',
    });
    expect(advancedResolved).toBe(1);
    expect(order.status).toBe('RELEASED');
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(expect.anything(), 'RELEASED');

    expect(userReputation.recordDisputeLost).not.toHaveBeenCalled();
  });
});

describe('IndexerService.poll — RPC timeout resilience (Ops M-1 fix)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('a hung server.getEvents() call times out (does not hang forever) and `running` resets so poll() can run again — L-B fix: does NOT cold-start, cursor preserved', async () => {
    jest.useFakeTimers();

    const getEvents = jest.fn().mockImplementation(() => new Promise(() => {}));
    const getLatestLedger = jest.fn().mockResolvedValue({ sequence: 1000 });

    jest.resetModules();
    jest.doMock('@stellar/stellar-sdk/rpc', () => {
      const actual = jest.requireActual('@stellar/stellar-sdk/rpc');
      return { ...actual, Server: jest.fn().mockImplementation(() => ({ getEvents, getLatestLedger })) };
    });
    const { IndexerService: MockedIndexerService } = require('./indexer.service');

    const prisma = {
      indexedEvent: eventLedger(),
      indexerState: {
        findUnique: jest.fn().mockResolvedValue({ cursor: 'CUR1' }),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
    const cfg = { rpcUrl: 'x', escrowContractId: 'CXXX', escrowContractIdsExtra: [] } as any;
    const notifications = {} as any;
    const stellar = {} as any;
    const userReputation = {} as any;
    const svc = new MockedIndexerService(prisma, cfg, notifications, stellar, userReputation) as any;

    expect(svc.running).toBe(false);
    const pollPromise = svc.poll();

    expect(svc.running).toBe(true);

    await jest.advanceTimersByTimeAsync(5000);
    await pollPromise;

    expect(svc.running).toBe(false);
    expect(getEvents).toHaveBeenCalledTimes(1);
    expect(getLatestLedger).not.toHaveBeenCalled();
    expect(prisma.indexerState.upsert).not.toHaveBeenCalled();

    const secondPoll = svc.poll();
    expect(svc.running).toBe(true);
    await jest.advanceTimersByTimeAsync(5000);
    await secondPoll;
    expect(svc.running).toBe(false);
    expect(prisma.indexerState.findUnique).toHaveBeenCalledTimes(2);
  });

  it('a hung server.getLatestLedger() (coldStart, no cursor) times out and `running` resets', async () => {
    jest.useFakeTimers();

    const getLatestLedger = jest.fn().mockImplementation(() => new Promise(() => {}));
    const getEvents = jest.fn();

    jest.resetModules();
    jest.doMock('@stellar/stellar-sdk/rpc', () => {
      const actual = jest.requireActual('@stellar/stellar-sdk/rpc');
      return { ...actual, Server: jest.fn().mockImplementation(() => ({ getEvents, getLatestLedger })) };
    });
    const { IndexerService: MockedIndexerService } = require('./indexer.service');

    const prisma = {
      indexedEvent: eventLedger(),
      indexerState: { findUnique: jest.fn().mockResolvedValue(null) },
    } as any;
    const cfg = { rpcUrl: 'x', escrowContractId: 'CXXX', escrowContractIdsExtra: [] } as any;
    const svc = new MockedIndexerService(prisma, cfg, {} as any, {} as any, {} as any) as any;

    const pollPromise = svc.poll();
    expect(svc.running).toBe(true);

    await jest.advanceTimersByTimeAsync(5000);
    await pollPromise;

    expect(svc.running).toBe(false);
    expect(getEvents).not.toHaveBeenCalled();
    expect(getLatestLedger).toHaveBeenCalledTimes(1);
  });
});

describe('IndexerService.poll — cursor-safe timeout vs genuine retention error (L-B fix)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  function loadMockedIndexerService(getEvents: jest.Mock, getLatestLedger: jest.Mock) {
    jest.resetModules();
    jest.doMock('@stellar/stellar-sdk/rpc', () => {
      const actual = jest.requireActual('@stellar/stellar-sdk/rpc');
      return { ...actual, Server: jest.fn().mockImplementation(() => ({ getEvents, getLatestLedger })) };
    });
    return require('./indexer.service').IndexerService;
  }

  it('a generic/transient getEvents(cursor) error (not the retention shape) does NOT cold-start: no coldStart call, cursor left unchanged', async () => {
    const getEvents = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const getLatestLedger = jest.fn().mockResolvedValue({ sequence: 1000 });
    const MockedIndexerService = loadMockedIndexerService(getEvents, getLatestLedger);

    const prisma = {
      indexedEvent: eventLedger(),
      indexerState: {
        findUnique: jest.fn().mockResolvedValue({ cursor: 'CUR1' }),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
    const cfg = { rpcUrl: 'x', escrowContractId: 'CXXX', escrowContractIdsExtra: [] } as any;
    const svc = new MockedIndexerService(prisma, cfg, {} as any, {} as any, {} as any) as any;

    await svc.poll();

    expect(getEvents).toHaveBeenCalledTimes(1);
    expect(getLatestLedger).not.toHaveBeenCalled();
    expect(prisma.indexerState.upsert).not.toHaveBeenCalled();
  });

  it('a genuine retention-class error (-32600, "ledger range") DOES cold-start: coldStart + a retry getEvents call, cursor advances', async () => {
    const retentionError = { code: -32600, message: 'startLedger must be within the ledger range: 100 - 200' };
    const getEvents = jest
      .fn()
      .mockRejectedValueOnce(retentionError)
      .mockResolvedValueOnce({ events: [], cursor: 'CUR-COLD' });
    const getLatestLedger = jest.fn().mockResolvedValue({ sequence: 1000 });
    const MockedIndexerService = loadMockedIndexerService(getEvents, getLatestLedger);

    const prisma = {
      indexedEvent: eventLedger(),
      indexerState: {
        findUnique: jest.fn().mockResolvedValue({ cursor: 'CUR1' }),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
    const cfg = { rpcUrl: 'x', escrowContractId: 'CXXX', escrowContractIdsExtra: [] } as any;
    const svc = new MockedIndexerService(prisma, cfg, {} as any, {} as any, {} as any) as any;

    await svc.poll();

    expect(getEvents).toHaveBeenCalledTimes(2);
    expect(getLatestLedger).toHaveBeenCalledTimes(1);
    expect(prisma.indexerState.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      update: { cursor: 'CUR-COLD' },
      create: { id: 1, cursor: 'CUR-COLD' },
    });
  });

  it('an error object shaped like -32600 but with an UNRELATED message does not cold-start (fail-closed, not just code-matching)', async () => {
    const notRetention = { code: -32600, message: 'invalid contract ID: not-a-real-address' };
    const getEvents = jest.fn().mockRejectedValue(notRetention);
    const getLatestLedger = jest.fn();
    const MockedIndexerService = loadMockedIndexerService(getEvents, getLatestLedger);

    const prisma = {
      indexedEvent: eventLedger(),
      indexerState: {
        findUnique: jest.fn().mockResolvedValue({ cursor: 'CUR1' }),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    } as any;
    const cfg = { rpcUrl: 'x', escrowContractId: 'CXXX', escrowContractIdsExtra: [] } as any;
    const svc = new MockedIndexerService(prisma, cfg, {} as any, {} as any, {} as any) as any;

    await svc.poll();

    expect(getEvents).toHaveBeenCalledTimes(1);
    expect(getLatestLedger).not.toHaveBeenCalled();
    expect(prisma.indexerState.upsert).not.toHaveBeenCalled();
  });
});

function makeBase(
  orderStatus: string,
  opts: {
    cfgOverrides?: any;
    stellarOverrides?: any;
    updateManyCount?: number;
    orderContractId?: string | null;
    flow?: string;
  } = {},
) {
  const order = {
    id: 'ord-1',
    tradeId: TRADE_ID_A,
    contractId: opts.orderContractId ?? null,
    userAddress: 'GUSER',
    lpWallet: 'GLP',
    flow: opts.flow ?? 'TOP_UP',
    status: orderStatus,
    usdcAmount: 100_0000000n,
    fiatAmount: 1_630_000n,
    fiatCurrency: 'IDR',
    platformFeeBps: 30,
    lpFeeBps: 120,
    platformWallet: 'GPLATFORM',
    payDeadline: 1_800n,
    confirmDeadline: 3_600n,
    disputeDeadline: 10_800n,
  };
  const prisma = {
    indexedEvent: eventLedger(),
    order: {
      findUnique: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue(order),
      updateMany: jest.fn().mockResolvedValue({ count: opts.updateManyCount ?? 1 }),
    },
    adminAudit: { create: jest.fn().mockResolvedValue(undefined) },
  } as any;
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const cfg = { rpcUrl: 'x', escrowContractId: 'CXXX', escrowContractIdsExtra: [], ...opts.cfgOverrides } as any;
  const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
  const stellar = {
    getTradeStatus: jest.fn(),
    getTradeStatusStrict: jest.fn().mockResolvedValue(boundTrade(order)),
    ...opts.stellarOverrides,
  } as any;
  const userReputation = { recordDisputeLost: jest.fn().mockResolvedValue(undefined) } as any;
  return {
    svc: new IndexerService(prisma, cfg, notifications, stellar, userReputation) as any,
    prisma,
    notifications,
    stellar,
    cfg,
    userReputation,
  };
}

describe('IndexerService.applyEvent — a verdict closes the dispute round (ADR 0043)', () => {
  const FILED_AT = new Date('2026-09-07T10:00:00.000Z');
  const filing = {
    disputeBy: 'user',
    disputeReason: 'PAYMENT_NOT_RECEIVED',
    disputeNote: 'no money arrived',
    disputeEvidenceUrl: 'evidence/ord-1-user.jpg',
    disputeAt: FILED_AT,
    onChainDisputedBy: 'GUSER',
  };

  async function withRow(orderStatus: string, row: Record<string, any>, stellarOverrides: Record<string, any> = {}) {
    const base = makeBase(orderStatus, {
      stellarOverrides: {
        getTradeStatus: jest.fn().mockResolvedValue({ settledAt: 1_700_000_000, postSettleDeadline: 1_700_086_400n }),
        ...stellarOverrides,
      },
    });
    const seed = await base.prisma.order.findUnique();
    const matches = (row: any, where: any): boolean =>
      Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
        if (k === 'OR') return (v as any[]).some((clause) => matches(row, clause));
        if (v && typeof v === 'object' && 'in' in v) return (v.in as any[]).includes(row[k]);
        if (v && typeof v === 'object' && 'not' in v) return v.not === null ? row[k] != null : row[k] !== v.not;
        return row[k] === v;
      });
    let current: any = {
      ...seed,
      disputeBy: null,
      disputeReason: null,
      disputeNote: null,
      disputeEvidenceUrl: null,
      disputeAt: null,
      onChainDisputedBy: null,
      disputeClosedAt: null,
      resolution: null,
      ...row,
    };
    const tx = {
      indexedEvent: eventLedger(),
      order: {
        findUnique: jest.fn().mockImplementation(async () => ({ ...current })),
        updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
          if (!matches(current, where)) return { count: 0 };
          current = { ...current, ...data };
          return { count: 1 };
        }),
      },
      adminAudit: { create: jest.fn().mockResolvedValue(undefined) },
    };
    base.prisma.$transaction = jest.fn(async (fn: any) => fn(tx));
    base.prisma.order.findUnique.mockImplementation(async () => ({ ...current }));
    return { ...base, tx, row: () => current };
  }

  const verdict = (post_settle = false) => ({
    id: 'ev-1951',
    topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
    value: nativeToScVal({ released: true, post_settle }),
    contractId: 'CXXX',
  });

  it('nulls the filing, keeps its time and its evidence, sets the marker and records the round — every write on the transaction client', async () => {
    const { svc, prisma, tx, row } = await withRow('DISPUTED', filing);

    expect(await svc.applyEvent(verdict())).toBe(1);

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'RELEASED', resolution: 'released' }) }),
    );
    expect(row()).toMatchObject({
      status: 'RELEASED',
      disputeBy: null,
      disputeReason: null,
      disputeNote: null,
      onChainDisputedBy: null,
      disputeEvidenceUrl: 'evidence/ord-1-user.jpg',
      disputeAt: FILED_AT,
    });
    expect(row().disputeClosedAt).toBeInstanceOf(Date);

    expect(tx.adminAudit.create).toHaveBeenCalledTimes(1);
    const { data } = tx.adminAudit.create.mock.calls[0][0];
    expect(data).toMatchObject({ actorAddress: 'CXXX', action: 'order.disputeRoundClosed', targetType: 'Order', targetId: 'ord-1', after: null });
    expect(data.before).toEqual({
      disputeBy: 'user',
      disputeReason: 'PAYMENT_NOT_RECEIVED',
      disputeNote: 'no money arrived',
      disputeEvidenceUrl: 'evidence/ord-1-user.jpg',
      disputeAt: '2026-09-07T10:00:00.000Z',
      onChainDisputedBy: 'GUSER',
    });
  });

  it('closes the round from FIAT_PAID too, when the verdict lands before the dispute event was indexed', async () => {
    const { svc, tx, row } = await withRow('FIAT_PAID', filing);

    expect(await svc.applyEvent(verdict())).toBe(1);

    expect(row()).toMatchObject({ status: 'RELEASED', disputeBy: null, disputeAt: FILED_AT });
    expect(tx.adminAudit.create).toHaveBeenCalledTimes(1);
  });

  it('closes a round the chain raised without a filing on record', async () => {
    const { svc, tx, row } = await withRow('DISPUTED', { onChainDisputedBy: 'GRESOLVER', disputeAt: FILED_AT });

    expect(await svc.applyEvent(verdict())).toBe(1);

    expect(row()).toMatchObject({ onChainDisputedBy: null, disputeAt: FILED_AT });
    expect(row().disputeClosedAt).toBeInstanceOf(Date);
    expect(tx.adminAudit.create).toHaveBeenCalledTimes(1);
    expect(tx.adminAudit.create.mock.calls[0][0].data.before).toMatchObject({ disputeBy: null, onChainDisputedBy: 'GRESOLVER' });
  });

  it('a verdict with no round open writes nothing beyond the status', async () => {
    const { svc, tx, row } = await withRow('DISPUTED', {});

    expect(await svc.applyEvent(verdict())).toBe(1);

    expect(tx.adminAudit.create).not.toHaveBeenCalled();
    expect(row().disputeClosedAt).toBeNull();
  });

  it('a replayed verdict writes no second audit row and does not move the marker', async () => {
    const { svc, tx, row } = await withRow('DISPUTED', filing);
    await svc.applyEvent(verdict());
    const marker = row().disputeClosedAt;
    tx.adminAudit.create.mockClear();

    await svc.applyEvent(verdict());

    expect(tx.adminAudit.create).not.toHaveBeenCalled();
    expect(row().disputeClosedAt).toBe(marker);
  });

  it('a replayed verdict leaves a LATER round untouched, because the chain resolved the round before it and not this one', async () => {
    const { svc, tx, row } = await withRow('DISPUTED', {
      resolution: 'released',
      disputeBy: 'lp',
      disputeReason: 'FAKE_PROOF',
      disputeNote: 'the proof was doctored',
      onChainDisputedBy: 'GLP',
      disputeAt: new Date('2026-09-07T12:00:00.000Z'),
      disputeClosedAt: new Date('2026-09-07T11:00:00.000Z'),
    });

    expect(await svc.applyEvent(verdict())).toBe(0);

    expect(row()).toMatchObject({ status: 'DISPUTED', disputeBy: 'lp', disputeReason: 'FAKE_PROOF', onChainDisputedBy: 'GLP' });
    expect(row().disputeClosedAt).toEqual(new Date('2026-09-07T11:00:00.000Z'));
    expect(tx.adminAudit.create).not.toHaveBeenCalled();
  });

  it('a post-settlement verdict this indexer has already applied leaves the round opened after it untouched', async () => {
    const { svc, tx, row } = await withRow(
      'DISPUTED',
      filing,
      { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'RELEASED', liabilityEstablished: true, slashDeadline: 1_700_090_000n }) },
    );

    expect(await svc.applyEvent(verdict(true))).toBe(1);
    const firstClose = row().disputeClosedAt;
    expect(firstClose).toBeInstanceOf(Date);
    expect(tx.adminAudit.create).toHaveBeenCalledTimes(1);

    await tx.order.updateMany({
      where: { id: 'ord-1' },
      data: {
        status: 'DISPUTED',
        disputeBy: 'lp',
        disputeReason: 'FAKE_PROOF',
        disputeNote: 'filed after the verdict',
        onChainDisputedBy: 'GLP',
      },
    });

    expect(await svc.applyEvent(verdict(true))).toBe(0);

    expect(row()).toMatchObject({
      status: 'DISPUTED',
      disputeBy: 'lp',
      disputeNote: 'filed after the verdict',
      onChainDisputedBy: 'GLP',
    });
    expect(row().disputeClosedAt).toEqual(firstClose);
    expect(tx.adminAudit.create).toHaveBeenCalledTimes(1);
  });

  it('stops a replayed pre-settlement verdict at the ledger, before the row write, so a cold start is not reported as a refusal', async () => {
    const { svc, tx } = await withRow('DISPUTED', filing);

    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      expect(await svc.applyEvent(verdict())).toBe(1);
      const writesWhenTheVerdictLanded = (tx.order.updateMany as jest.Mock).mock.calls.length;

      expect(await svc.applyEvent(verdict())).toBe(0);

      expect((tx.order.updateMany as jest.Mock).mock.calls.length).toBe(writesWhenTheVerdictLanded);
      expect(tx.adminAudit.create).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('has already been applied'));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
      warn.mockRestore();
    }
  });

  it('never applies a post-settlement verdict it once refused because a newer round was live, even after that round ends', async () => {
    const { svc, prisma, notifications } = makeBase('RELEASED', {
      stellarOverrides: {
        getTradeStatusStrict: jest
          .fn()
          .mockResolvedValueOnce({ status: 'DISPUTED' })
          .mockResolvedValue({ status: 'RELEASED', liabilityEstablished: true, slashDeadline: 1_700_090_000n }),
      },
      orderContractId: 'CEVENTCONTRACT',
    });
    const midRound = {
      id: 'ev-refused-mid-round',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ released: true, post_settle: true }),
      contractId: 'CEVENTCONTRACT',
    };

    expect(await svc.applyEvent(midRound)).toBe(0);
    expect(await svc.applyEvent(midRound)).toBe(0);

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('keeps a post-settlement verdict alive when the chain could not be read at all, because a trade the RPC did not find is not a verdict this indexer has decided', async () => {
    const { svc, prisma } = makeBase('RELEASED', {
      stellarOverrides: {
        getTradeStatusStrict: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue({ status: 'RELEASED', liabilityEstablished: true, slashDeadline: 1_700_090_000n }),
      },
      orderContractId: 'CEVENTCONTRACT',
    });
    const unread = {
      id: 'ev-chain-unreadable',
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ released: true, post_settle: true }),
      contractId: 'CEVENTCONTRACT',
    };

    expect(await svc.applyEvent(unread)).toBe(0);
    expect(prisma.indexedEvent.createMany).not.toHaveBeenCalled();

    expect(await svc.applyEvent(unread)).toBe(1);
  });

  it('claims nothing when the event is refused before the verdict is ever read, so the operator who fixes the binding gets the verdict', async () => {
    const { svc, prisma } = makeBase('MATCHED', {
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue(null) },
      orderContractId: 'CEVENTCONTRACT',
    });

    expect(
      await svc.applyEvent({
        id: 'ev-unbound',
        topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
        value: nativeToScVal({ released: true, post_settle: false }),
        contractId: 'CEVENTCONTRACT',
      }),
    ).toBe(0);

    expect(prisma.indexedEvent.createMany).not.toHaveBeenCalled();
  });

  it('claims nothing when the event came from a contract this order is not bound to', async () => {
    const { svc, prisma } = makeBase('DISPUTED', { orderContractId: 'CEVENTCONTRACT' });

    expect(
      await svc.applyEvent({
        id: 'ev-wrong-contract',
        topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
        value: nativeToScVal({ released: true, post_settle: false }),
        contractId: 'CSOMEOTHERCONTRACT',
      }),
    ).toBe(0);

    expect(prisma.indexedEvent.createMany).not.toHaveBeenCalled();
  });

  it('refuses to apply a verdict that arrived without an RPC event id, so the batch retries instead of applying it unidentified', async () => {
    const { svc, tx } = await withRow('DISPUTED', filing);

    await expect(svc.applyEvent({ ...verdict(), id: undefined })).rejects.toThrow(/without an RPC event id/);

    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.adminAudit.create).not.toHaveBeenCalled();
  });

  it('applies a post-settlement verdict it has never seen, even though the order page already advanced the row past DISPUTED', async () => {
    const { svc, tx, row } = await withRow(
      'RELEASED',
      {
        resolution: 'released',
        disputeBy: 'lp',
        disputeReason: 'FAKE_PROOF',
        disputeNote: 'filed after the first verdict',
        onChainDisputedBy: 'GLP',
        disputeAt: new Date('2026-09-07T12:00:00.000Z'),
        disputeClosedAt: new Date('2026-09-07T11:00:00.000Z'),
      },
      { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'REFUNDED', liabilityEstablished: true, slashDeadline: 1_700_090_000n }) },
    );

    expect(await svc.applyEvent(verdict(true))).toBe(1);

    expect(row()).toMatchObject({
      status: 'REFUNDED',
      resolution: 'released',
      disputeBy: null,
      disputeReason: null,
      disputeNote: null,
      onChainDisputedBy: null,
    });
    expect(row().disputeClosedAt.getTime()).toBeGreaterThan(new Date('2026-09-07T11:00:00.000Z').getTime());
    expect(tx.adminAudit.create).toHaveBeenCalledTimes(1);
  });

  it('closes nothing when the status write matched no row, because a round the chain did not resolve is not this verdict to end', async () => {
    const { svc, tx, row } = await withRow('RELEASED', { ...filing, resolution: 'released' });

    expect(await svc.applyEvent(verdict())).toBe(0);

    expect(row()).toMatchObject({ disputeBy: 'user', disputeReason: 'PAYMENT_NOT_RECEIVED' });
    expect(row().disputeClosedAt).toBeNull();
    expect(tx.adminAudit.create).not.toHaveBeenCalled();
  });

  it('clears the resolver marker too, so a later round the resolver did not raise is not attributed to it', async () => {
    const { svc, row } = await withRow('DISPUTED', { onChainDisputedBy: 'GRESOLVER', resolverDisputed: true, disputeAt: FILED_AT });

    expect(await svc.applyEvent(verdict())).toBe(1);

    expect(row().resolverDisputed).toBe(false);
  });

  it('a post-settlement verdict closes the round the same way', async () => {
    const { svc, prisma, tx, row } = await withRow('RELEASED', filing, {
      getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'RELEASED', liabilityEstablished: true, slashDeadline: 1_700_090_000n }),
    });

    expect(await svc.applyEvent(verdict(true))).toBe(1);

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: 'RELEASED', resolution: 'released', liabilityEstablished: true, disputeBy: null, disputeAt: FILED_AT });
    expect(tx.adminAudit.create).toHaveBeenCalledTimes(1);
  });
});

describe('IndexerService.applyEvent — a dispute after a closed round gets a fresh time', () => {
  const OLD = new Date('2026-09-01T00:00:00.000Z');

  it('a chain dispute after a closed round stamps now, not the earlier round\'s time', async () => {
    const { svc, prisma } = makeBase('RELEASED', {
      stellarOverrides: { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'DISPUTED' }) },
    });
    const seed = await prisma.order.findUnique();
    prisma.order.findUnique.mockResolvedValue({ ...seed, disputeAt: OLD, disputeBy: null, disputeClosedAt: new Date('2026-09-02T00:00:00.000Z') });
    const before = Date.now();

    expect(await svc.applyEvent({ topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)], value: nativeToScVal(null), contractId: 'CXXX' })).toBe(1);

    const stamped: Date = prisma.order.updateMany.mock.calls[0][0].data.disputeAt;
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('a chain dispute while a filing is open keeps the filing\'s time', async () => {
    const { svc, prisma } = makeBase('FIAT_PAID');
    const seed = await prisma.order.findUnique();
    prisma.order.findUnique.mockResolvedValue({ ...seed, disputeAt: OLD, disputeBy: 'user' });

    expect(await svc.applyEvent({ topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)], value: nativeToScVal(null), contractId: 'CXXX' })).toBe(1);

    expect(prisma.order.updateMany.mock.calls[0][0].data.disputeAt).toBe(OLD);
  });
});
