import { OrderStatusService } from './order-status.service';
import { NotificationService } from '../notification/notification.service';
import { onChainTradeFor } from './test-helpers';

const CONTRACT = 'CESCROW';
const TRADE_ID = 'd'.repeat(64);
const USER_ADDR = 'GUSER';
const LP_ADDR = 'GLP';
const PLATFORM = 'GPLATFORM';

function makeOrder(overrides: Partial<any> = {}): any {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'order-1',
    tradeId: TRADE_ID,
    contractId: CONTRACT,
    userAddress: USER_ADDR,
    flow: 'TOP_UP',
    status: 'MATCHED',
    fiatCurrency: 'IDR',
    usdcAmount: BigInt('100000000'),
    fiatAmount: BigInt('1600000'),
    platformFeeBps: 30,
    lpFeeBps: 120,
    platformWallet: PLATFORM,
    lpWallet: LP_ADDR,
    lpId: 'lp-1',
    payDeadline: BigInt(now + 1800),
    confirmDeadline: BigInt(now + 3600),
    disputeDeadline: BigInt(now + 7200),
    settledAt: null,
    disputeAt: null,
    lp: { id: 'lp-1', stellarAddress: LP_ADDR },
    ...overrides,
  };
}

function makeSvc(rowStatus: string, onChainStatus: string, notifications: any, seed: Partial<any> = {}) {
  const order = makeOrder({ status: rowStatus, ...seed });
  let current: any = { ...order };
  const onChain = onChainTradeFor(order, onChainStatus);
  const prisma: any = {
    order: {
      findUnique: jest.fn().mockImplementation(async () => current),
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const want = where.status;
        const matches =
          want === undefined ||
          (Array.isArray(want?.in) ? want.in.includes(current.status) : want === current.status);
        if (!matches) return { count: 0 };
        current = { ...current, ...data };
        return { count: 1 };
      }),
    },
  };
  const stellar: any = { getTradeStatus: jest.fn().mockResolvedValue(onChain) };
  const realtime: any = { emitOrderUpdate: jest.fn() };
  const svc = new OrderStatusService(prisma, stellar, { escrowContractId: CONTRACT } as any, realtime, notifications);
  return { svc, prisma, realtime, order, row: () => current };
}

describe('refreshOrderStatus notifies the parties it advances, not only the indexer', () => {
  it.each([
    ['MATCHED', 'FUNDED'],
    ['FUNDED', 'FIAT_PAID'],
    ['FIAT_PAID', 'DISPUTED'],
    ['FIAT_PAID', 'RELEASED'],
    ['FIAT_PAID', 'REFUNDED'],
  ])('notifies for a %s -> %s advance observed by a poll, not an indexed event', async (from, to) => {
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) };
    const { svc, row, order } = makeSvc(from, to, notifications);

    const updated = await svc.refreshOrderStatus('order-1', order);

    expect(notifications.notifyOrderStatus).toHaveBeenCalledTimes(1);
    expect(notifications.notifyOrderStatus.mock.calls[0][0]).toBe(row());
    expect(notifications.notifyOrderStatus.mock.calls[0][1]).toBe(to);
    expect(updated.status).toBe(to);
  });

  it('does not notify when another writer already applied the transition first', async () => {
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) };
    let current: any = { id: 'order-1', tradeId: TRADE_ID, contractId: CONTRACT, status: 'DISPUTED', lp: { id: 'lp-1' } };
    const prisma: any = {
      order: {
        findUnique: jest.fn().mockImplementation(async () => current),
        updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
          if (where.status !== undefined && where.status !== current.status) return { count: 0 };
          current = { ...current, ...data };
          return { count: 1 };
        }),
      },
    };
    const stellar: any = { getTradeStatus: jest.fn().mockResolvedValue({ status: 'FIAT_PAID' }) };
    const svc = new OrderStatusService(prisma, stellar, { escrowContractId: CONTRACT } as any, undefined, notifications as any);

    await svc.refreshOrderStatus('order-1', { id: 'order-1', tradeId: TRADE_ID, contractId: CONTRACT, status: 'FUNDED' });

    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('still returns the updated order when notifying fails, since this runs on a GET path', async () => {
    const notifications = { notifyOrderStatus: jest.fn().mockRejectedValue(new Error('outbox down')) };
    const { svc, order } = makeSvc('MATCHED', 'FUNDED', notifications);

    const updated = await svc.refreshOrderStatus('order-1', order);

    expect(updated.status).toBe('FUNDED');
  });

  it('never throws when notifications is not wired, since it is an optional dependency', async () => {
    const { svc, order } = makeSvc('MATCHED', 'FUNDED', undefined);

    await expect(svc.refreshOrderStatus('order-1', order)).resolves.toMatchObject({ status: 'FUNDED' });
  });

  it('writes an actual Notification row for the depositor through the real NotificationService, not just a stub call', async () => {
    const rows: any[] = [];
    const notifPrisma: any = {
      notification: { createMany: jest.fn().mockImplementation(async ({ data }: any) => { rows.push(...data); return { count: data.length }; }) },
      lp: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    notifPrisma.$transaction = jest.fn(async (cb: any) => cb(notifPrisma));
    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const people = { lookupPerson: jest.fn().mockResolvedValue(null) };
    const notifications = new NotificationService(notifPrisma, outbox as any, people as any, undefined);

    const { svc, order } = makeSvc('MATCHED', 'FUNDED', notifications);

    await svc.refreshOrderStatus('order-1', order);

    expect(rows).toContainEqual(
      expect.objectContaining({ address: USER_ADDR, orderId: 'order-1', event: 'FUNDED' }),
    );
  });
});
