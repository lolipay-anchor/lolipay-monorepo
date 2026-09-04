import { Logger } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';

describe('MaintenanceService', () => {
  function make(onChain: any = null, throwOnStrict = false, orders?: any[]) {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue(orders ?? [{ id: 'o1', tradeId: 'abc' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quote: { deleteMany: jest.fn().mockResolvedValue({ count: 7 }) },
      walletLinkChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
      consumedChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      config: { findUnique: jest.fn().mockResolvedValue({ autoRefund: false }) },
    } as any;
    const stellar = {
      getTradeStatusStrict: jest.fn(
        throwOnStrict
          ? () => Promise.reject(new Error('rpc down'))
          : () => Promise.resolve(onChain),
      ),
    } as any;
    const refundSigner = {
      isConfigured: false,
      publicKey: null,
      submitRefund: jest.fn(),
    } as any;
    const cfg = { escrowContractId: 'CESCROW' } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    return {
      svc: new MaintenanceService(prisma, stellar, refundSigner, cfg, notifications, { raise: jest.fn(async () => ({ sent: [], cleared: [] })) } as any, { prune: jest.fn(async () => 0), stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })) } as any),
      prisma,
      stellar,
      refundSigner,
      cfg,
      notifications,
    };
  }

  const BINDABLE_ORDER = {
    id: 'o1',
    tradeId: 'abc',
    contractId: null,
    status: 'MATCHED',
    userAddress: 'GUSER',
    lpWallet: 'GLP',
    flow: 'TOP_UP',
    usdcAmount: 1_000_000_000n,
    fiatAmount: 16_000_000n,
    fiatCurrency: 'IDR',
    platformFeeBps: 30,
    lpFeeBps: 120,
    platformWallet: 'GPLATFORM',
    payDeadline: 100n,
    confirmDeadline: 200n,
    disputeDeadline: 300n,
  };

  function tradeFor(order: any, overrides: Record<string, any> = {}) {
    return {
      status: 'FUNDED',
      settledAt: 0,
      usdcAmount: order.usdcAmount,
      fiatAmount: order.fiatAmount,
      fiatCurrency: order.fiatCurrency,
      flow: 0,
      usdcProvider: order.lpWallet,
      usdcRecipient: order.userAddress,
      confirmer: order.lpWallet,
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

  it('expires a stale order whose on-chain trade does not belong to it', async () => {
    const squatted = tradeFor(BINDABLE_ORDER, { usdcAmount: 1n });
    const { svc, prisma } = make(squatted, false, [BINDABLE_ORDER]);

    await svc.expireStaleOrders();

    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'EXPIRED' } }),
    );
  });

  it('does NOT expire an order that is actually funded on-chain under its own trade', async () => {
    const { svc, prisma } = make(tradeFor(BINDABLE_ORDER), false, [BINDABLE_ORDER]);

    await svc.expireStaleOrders();

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('sweeps a full minute behind the signing cut-off, so a signature the ledger accepted in the last second is never marked EXPIRED before the RPC has seen it', async () => {
    const { svc, prisma } = make(null);
    const before = Date.now();
    await svc.expireStaleOrders();
    const lt: Date = prisma.order.findMany.mock.calls[0][0].where.expiresAt.lt;
    expect(before - lt.getTime()).toBeGreaterThanOrEqual(60_000);
    expect(before - lt.getTime()).toBeLessThan(120_000);
  });

  it('expires a pre-chain order that is NOT on-chain', async () => {
    const { svc, prisma } = make(null);
    await svc.expireStaleOrders();
    const where = prisma.order.findMany.mock.calls[0][0].where;

    expect(where.status.in).toEqual(['CREATED', 'MATCHED', 'AWAITING_ONCHAIN']);
    expect(where.expiresAt.lt).toBeInstanceOf(Date);
    expect(prisma.order.updateMany.mock.calls[0][0].data).toEqual({ status: 'EXPIRED' });
  });


  it('fail-closed: does NOT expire when the strict on-chain read errors', async () => {
    const { svc, prisma } = make(null, true);
    await svc.expireStaleOrders();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('a MATCHED order whose strict read resolves null (escrow TradeNotFound #5, never funded) IS expired — the root-cause bug', async () => {
    const matchedOrder = {
      id: 'o1',
      tradeId: 'abc',
      status: 'MATCHED',
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'TOP_UP',
    };
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([matchedOrder]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quote: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      walletLinkChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      consumedChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      config: { findUnique: jest.fn().mockResolvedValue({ autoRefund: false }) },
    } as any;

    const stellar = { getTradeStatusStrict: jest.fn().mockResolvedValue(null) } as any;
    const refundSigner = { isConfigured: false, publicKey: null, submitRefund: jest.fn() } as any;
    const cfg = { escrowContractId: 'CESCROW' } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new MaintenanceService(prisma, stellar, refundSigner, cfg, notifications, { raise: jest.fn(async () => ({ sent: [], cleared: [] })) } as any, { prune: jest.fn(async () => 0), stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })) } as any);

    await svc.expireStaleOrders();

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: { in: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN'] } },
      data: { status: 'EXPIRED' },
    });
  });

  it('expires a stale MATCHED order (TOP_UP/WITHDRAW, LP already matched at creation) and notifies both parties (MATCHED_EXPIRED)', async () => {
    const matchedOrder = {
      id: 'o1',
      tradeId: 'abc',
      status: 'MATCHED',
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'TOP_UP',
    };
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([matchedOrder]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quote: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      walletLinkChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      consumedChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      config: { findUnique: jest.fn().mockResolvedValue({ autoRefund: false }) },
    } as any;
    const stellar = { getTradeStatusStrict: jest.fn().mockResolvedValue(null) } as any;
    const refundSigner = { isConfigured: false, publicKey: null, submitRefund: jest.fn() } as any;
    const cfg = { escrowContractId: 'CESCROW' } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new MaintenanceService(prisma, stellar, refundSigner, cfg, notifications, { raise: jest.fn(async () => ({ sent: [], cleared: [] })) } as any, { prune: jest.fn(async () => 0), stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })) } as any);

    await svc.expireStaleOrders();

    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1' }),
      'MATCHED_EXPIRED',
    );
  });

  it('one order failing to notify (expireStaleOrders) does NOT stop the rest of the batch', async () => {
    const orders = [
      { id: 'o-bad', tradeId: 'bad', status: 'MATCHED', userAddress: 'GBAD', lpWallet: 'GLPBAD', flow: 'TOP_UP' },
      { id: 'o-good', tradeId: 'good', status: 'MATCHED', userAddress: 'GGOOD', lpWallet: 'GLPGOOD', flow: 'TOP_UP' },
    ];
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue(orders),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quote: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      walletLinkChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      consumedChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      config: { findUnique: jest.fn().mockResolvedValue({ autoRefund: false }) },
    } as any;
    const stellar = { getTradeStatusStrict: jest.fn().mockResolvedValue(null) } as any;
    const refundSigner = { isConfigured: false, publicKey: null, submitRefund: jest.fn() } as any;
    const cfg = { escrowContractId: 'CESCROW' } as any;
    let call = 0;
    const notifications = {
      notifyOrderStatus: jest.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('notify failed');
      }),
    } as any;
    const svc = new MaintenanceService(prisma, stellar, refundSigner, cfg, notifications, { raise: jest.fn(async () => ({ sent: [], cleared: [] })) } as any, { prune: jest.fn(async () => 0), stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })) } as any);

    await svc.expireStaleOrders();

    expect(prisma.order.updateMany).toHaveBeenCalledTimes(2);
    expect(notifications.notifyOrderStatus).toHaveBeenCalledTimes(2);
  });

  it('a CREATED/MATCHED/AWAITING_ONCHAIN expiry notifies with MATCHED_EXPIRED (L1/L2 fix)', async () => {
    const { svc, notifications } = make(null);
    await svc.expireStaleOrders();
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1' }),
      'MATCHED_EXPIRED',
    );
  });

  it('idempotent: a raced-away ACCEPTED order (updateMany count 0) is not notified', async () => {
    const acceptedOrder = {
      id: 'o1',
      tradeId: 'abc',
      status: 'MATCHED',
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'WITHDRAW',
    };
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([acceptedOrder]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      quote: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      walletLinkChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      consumedChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      config: { findUnique: jest.fn().mockResolvedValue({ autoRefund: false }) },
    } as any;
    const stellar = { getTradeStatusStrict: jest.fn().mockResolvedValue(null) } as any;
    const refundSigner = { isConfigured: false, publicKey: null, submitRefund: jest.fn() } as any;
    const cfg = { escrowContractId: 'CESCROW' } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new MaintenanceService(prisma, stellar, refundSigner, cfg, notifications, { raise: jest.fn(async () => ({ sent: [], cleared: [] })) } as any, { prune: jest.fn(async () => 0), stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })) } as any);

    await svc.expireStaleOrders();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('prunes quotes expired more than an hour ago', async () => {
    const { svc, prisma } = make();
    await svc.pruneOldQuotes();
    const arg = prisma.quote.deleteMany.mock.calls[0][0];
    expect(arg.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(Date.now() - arg.where.expiresAt.lt.getTime()).toBeGreaterThanOrEqual(3_600_000 - 5000);
  });
});

describe('MaintenanceService.autoRefundExpired', () => {
  function makeOrders(rows: { id: string; tradeId: string }[] = [{ id: 'o1', tradeId: 'trade1' }]) {
    return {
      findMany: jest.fn().mockResolvedValue(rows),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),

      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve({
          id: where.id,
          tradeId: rows.find((r) => r.id === where.id)?.tradeId ?? 'unknown',
          userAddress: 'GUSER',
          lpWallet: 'GLP',
          flow: 'TOP_UP',
        }),
      ),
    };
  }

  function make(opts: {
    autoRefund?: boolean;
    signerConfigured?: boolean;
    onChainStatus?: string | null;
    onChainThrows?: boolean;
    submitRefundResult?: { status: string; hash: string };
    submitRefundThrows?: boolean;
    orders?: { id: string; tradeId: string }[];
  } = {}) {
    const {
      autoRefund = true,
      signerConfigured = true,
      onChainStatus = 'FUNDED',
      onChainThrows = false,
      submitRefundResult = { status: 'SUCCESS', hash: 'deadbeef' },
      submitRefundThrows = false,
      orders = [{ id: 'o1', tradeId: 'trade1' }],
    } = opts;

    const orderTable = makeOrders(orders);
    const prisma = {
      order: orderTable,
      quote: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      walletLinkChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      consumedChallenge: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      config: { findUnique: jest.fn().mockResolvedValue({ autoRefund }) },
    } as any;

    const stellar = {
      getTradeStatusStrict: jest.fn(async () => {
        if (onChainThrows) throw new Error('rpc down');
        return onChainStatus ? { status: onChainStatus } : null;
      }),
    } as any;

    const refundSigner = {
      isConfigured: signerConfigured,
      publicKey: signerConfigured ? 'GSIGNERPUBKEY' : null,
      submitRefund: jest.fn(async () => {
        if (submitRefundThrows) throw new Error('submit failed');
        return submitRefundResult;
      }),
    } as any;

    const cfg = { escrowContractId: 'CESCROW' } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;

    return {
      svc: new MaintenanceService(prisma, stellar, refundSigner, cfg, notifications, { raise: jest.fn(async () => ({ sent: [], cleared: [] })) } as any, { prune: jest.fn(async () => 0), stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })) } as any),
      prisma,
      stellar,
      refundSigner,
      cfg,
      orderTable,
      notifications,
    };
  }

  it('records that the refund settled the trade, so the bond it returns stops being counted', async () => {
    const { svc, prisma, stellar } = make();
    (stellar.getTradeStatusStrict as jest.Mock)
      .mockResolvedValueOnce({ status: 'FUNDED' })
      .mockResolvedValueOnce({
        status: 'REFUNDED',
        settledAt: 1_800_000_000,
        postSettleDeadline: 1_800_086_400n,
      });

    await svc.autoRefundExpired();

    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REFUNDED',
          settledAt: new Date(1_800_000_000 * 1000),
          postSettleDeadline: 1_800_086_400n,
        }),
      }),
    );
  });

  it('still stamps a settlement time when the chain cannot be read back after the refund', async () => {
    const { svc, prisma, stellar } = make();
    (stellar.getTradeStatusStrict as jest.Mock)
      .mockResolvedValueOnce({ status: 'FUNDED' })
      .mockRejectedValueOnce(new Error('rpc down'));

    await svc.autoRefundExpired();

    const data = (prisma.order.updateMany as jest.Mock).mock.calls[0][0].data;
    expect(data.status).toBe('REFUNDED');
    expect(data.settledAt).toBeInstanceOf(Date);
  });

  it('does nothing when Config.autoRefund is false', async () => {
    const { svc, prisma, refundSigner } = make({ autoRefund: false });
    await svc.autoRefundExpired();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(refundSigner.submitRefund).not.toHaveBeenCalled();
  });

  it('skips and warns ONCE per boot when the signer is not configured', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, prisma } = make({ signerConfigured: false });

    await svc.autoRefundExpired();
    await svc.autoRefundExpired();

    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('never asks the chain to refund before the escrow will accept it', async () => {
    const { svc, prisma } = make();
    await svc.autoRefundExpired();
    const arg = prisma.order.findMany.mock.calls[0][0];
    expect(arg.where.status).toBe('FUNDED');
    expect(arg.where.payDeadline).toBeUndefined();
    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    const [byConfirm, byGrace] = arg.where.OR;
    expect(byConfirm.confirmDeadline.lt).toBeGreaterThan(nowSecs - 5n);
    expect(byConfirm.confirmDeadline.lt).toBeLessThanOrEqual(nowSecs);
    expect(byGrace.flow).toBe('TOP_UP');
    expect(byGrace.payDeadline.lt).toBe(byConfirm.confirmDeadline.lt - 3600n);
    expect(arg.take).toBe(20);
  });

  it('skips an order whose on-chain status is no longer FUNDED (already advanced elsewhere)', async () => {
    const { svc, refundSigner, orderTable } = make({ onChainStatus: 'FIAT_PAID' });
    await svc.autoRefundExpired();
    expect(refundSigner.submitRefund).not.toHaveBeenCalled();
    expect(orderTable.updateMany).not.toHaveBeenCalled();
  });

  it('fail-closed: skips an order when the strict on-chain read errors', async () => {
    const { svc, refundSigner, orderTable } = make({ onChainThrows: true });
    await svc.autoRefundExpired();
    expect(refundSigner.submitRefund).not.toHaveBeenCalled();
    expect(orderTable.updateMany).not.toHaveBeenCalled();
  });

  it('delegates to RefundSignerService.submitRefund(contractId, tradeId) and advances the order to REFUNDED on success', async () => {
    const { svc, refundSigner, orderTable } = make();
    await svc.autoRefundExpired();

    expect(refundSigner.submitRefund).toHaveBeenCalledWith('CESCROW', 'trade1');
    expect(refundSigner.submitRefund).toHaveBeenCalledTimes(1);
    expect(orderTable.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: 'FUNDED' },
      data: expect.objectContaining({ status: 'REFUNDED' }),
    });
  });

  describe('M1 fix: notify on auto-refund', () => {
    it('a successful auto-refund reloads the fresh order and calls notifyOrderStatus(order, REFUNDED) exactly once', async () => {
      const { svc, orderTable, notifications } = make();
      await svc.autoRefundExpired();

      expect(orderTable.findUnique).toHaveBeenCalledWith({ where: { id: 'o1' } });
      expect(notifications.notifyOrderStatus).toHaveBeenCalledTimes(1);
      expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'o1', userAddress: 'GUSER', lpWallet: 'GLP' }),
        'REFUNDED',
      );
    });

    it('a skipped order (on-chain no longer FUNDED) does NOT notify', async () => {
      const { svc, notifications } = make({ onChainStatus: 'FIAT_PAID' });
      await svc.autoRefundExpired();
      expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
    });

    it('a failed refund (submitRefund throws) does NOT notify', async () => {
      const { svc, notifications } = make({ submitRefundThrows: true });
      await svc.autoRefundExpired();
      expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
    });

    it('a non-SUCCESS submitRefund result does NOT notify', async () => {
      const { svc, notifications } = make({ submitRefundResult: { status: 'FAILED', hash: 'x' } });
      await svc.autoRefundExpired();
      expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
    });

    it('a raced-away advance (updateMany count 0, refunded elsewhere first) does NOT notify', async () => {
      const { svc, orderTable, notifications } = make();
      orderTable.updateMany.mockResolvedValue({ count: 0 });
      await svc.autoRefundExpired();
      expect(orderTable.findUnique).not.toHaveBeenCalled();
      expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
    });

    it('a notify failure is isolated (try/catch) — never breaks the refund it just completed, or the rest of the batch', async () => {
      const orders = [
        { id: 'o1', tradeId: 'trade1' },
        { id: 'o2', tradeId: 'trade2' },
      ];
      const orderTable = makeOrders(orders);
      orderTable.findUnique = jest.fn().mockRejectedValue(new Error('reload failed'));
      const prisma = {
        order: orderTable,
        config: { findUnique: jest.fn().mockResolvedValue({ autoRefund: true }) },
      } as any;
      const stellar = { getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'FUNDED' }) } as any;
      const refundSigner = {
        isConfigured: true,
        publicKey: 'GSIGNERPUBKEY',
        submitRefund: jest.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'h' }),
      } as any;
      const cfg = { escrowContractId: 'CESCROW' } as any;
      const notifications = { notifyOrderStatus: jest.fn() } as any;
      const svc = new MaintenanceService(prisma, stellar, refundSigner, cfg, notifications, { raise: jest.fn(async () => ({ sent: [], cleared: [] })) } as any, { prune: jest.fn(async () => 0), stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })) } as any);

      await svc.autoRefundExpired();

      expect(refundSigner.submitRefund).toHaveBeenCalledTimes(2);
      expect(orderTable.updateMany).toHaveBeenCalledTimes(2);
      expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
    });
  });

  it('does NOT advance the order when submitRefund resolves to a non-SUCCESS status', async () => {
    const { svc, orderTable } = make({ submitRefundResult: { status: 'FAILED', hash: 'x' } });
    await svc.autoRefundExpired();
    expect(orderTable.updateMany).not.toHaveBeenCalled();
  });

  it('one order failing (submitRefund throws) does NOT stop the rest of the batch', async () => {
    const orders = [
      { id: 'o-bad', tradeId: 'trade-bad' },
      { id: 'o-good', tradeId: 'trade-good' },
    ];
    const orderTable = makeOrders(orders);
    const prisma = {
      order: orderTable,
      config: { findUnique: jest.fn().mockResolvedValue({ autoRefund: true }) },
    } as any;
    const stellar = {
      getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'FUNDED' }),
    } as any;
    let call = 0;
    const refundSigner = {
      isConfigured: true,
      publicKey: 'GSIGNERPUBKEY',
      submitRefund: jest.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('submit failed for o-bad');
        return { status: 'SUCCESS', hash: 'good-hash' };
      }),
    } as any;
    const cfg = { escrowContractId: 'CESCROW' } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new MaintenanceService(prisma, stellar, refundSigner, cfg, notifications, { raise: jest.fn(async () => ({ sent: [], cleared: [] })) } as any, { prune: jest.fn(async () => 0), stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })) } as any);

    await svc.autoRefundExpired();

    expect(refundSigner.submitRefund).toHaveBeenCalledTimes(2);
    expect(orderTable.updateMany).toHaveBeenCalledTimes(1);
    expect(orderTable.updateMany).toHaveBeenCalledWith({
      where: { id: 'o-good', status: 'FUNDED' },
      data: expect.objectContaining({ status: 'REFUNDED' }),
    });

    expect(notifications.notifyOrderStatus).toHaveBeenCalledTimes(1);
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o-good' }),
      'REFUNDED',
    );
  });

  it('sweeps expired wallet-link challenges on the same hourly pass', async () => {
    const { svc, prisma } = make();

    await svc.pruneOldQuotes();

    const arg = prisma.walletLinkChallenge.deleteMany.mock.calls[0][0];
    expect(arg.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(arg.where.expiresAt.lt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('sweeps spent SEP-10 challenges on the same hourly pass', async () => {
    const { svc, prisma } = make();

    await svc.pruneOldQuotes();

    const arg = prisma.consumedChallenge.deleteMany.mock.calls[0][0];
    expect(arg.where.expiresAt.lt).toBeInstanceOf(Date);
  });
});
