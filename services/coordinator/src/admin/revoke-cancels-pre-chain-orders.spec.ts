import { ConflictException, Logger } from '@nestjs/common';
import { AdminService } from './admin.service';

const LP_ID = 'lp-1';
const OTHER_LP_ID = 'lp-2';

type Row = { id: string; lpId: string; status: string; userAddress: string; lpWallet: string; flow: string };

function row(id: string, status: string, lpId = LP_ID): Row {
  return { id, lpId, status, userAddress: 'GUSER', lpWallet: 'GLP', flow: 'WITHDRAW' };
}

function matches(r: Row, where: any): boolean {
  if (where.lpId !== undefined && r.lpId !== where.lpId) return false;
  if (where.id !== undefined) {
    if (typeof where.id === 'string' && r.id !== where.id) return false;
    if (where.id?.in !== undefined && !where.id.in.includes(r.id)) return false;
  }
  if (where.status !== undefined) {
    if (typeof where.status === 'string' && r.status !== where.status) return false;
    if (where.status?.in !== undefined && !where.status.in.includes(r.status)) return false;
  }
  return true;
}

function build(lpStatus = 'APPROVED', advanceBetweenStatements?: { id: string; to: string }) {
  const rows: Row[] = [
    row('created', 'CREATED'),
    row('matched', 'MATCHED'),
    row('awaiting', 'AWAITING_ONCHAIN'),
    row('funded', 'FUNDED'),
    row('fiat-paid', 'FIAT_PAID'),
    row('released', 'RELEASED'),
    row('other-lp-matched', 'MATCHED', OTHER_LP_ID),
  ];
  const client: any = {
    lp: {
      findUnique: jest.fn(async () => ({
        id: LP_ID,
        status: lpStatus,
        approvalNote: null,
        approvedAt: null,
        liquidityProof: 'proof',
        contact: 'tg:@lp',
      })),
      update: jest.fn(async ({ data }: any) => ({ id: LP_ID, ...data })),
    },
    order: {
      findMany: jest.fn(async ({ where }: any) => {
        const snapshot = rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
        if (advanceBetweenStatements) {
          const moved = rows.find((r) => r.id === advanceBetweenStatements.id);
          if (moved) moved.status = advanceBetweenStatements.to;
        }
        return snapshot;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    adminAudit: { create: jest.fn(async () => ({})) },
  };
  const atTransactionClose: Row[] = [];
  client.$transaction = jest.fn(async (cb: any) => {
    const out = await cb(client);
    atTransactionClose.push(...rows.map((r) => ({ ...r })));
    return out;
  });
  const notifications = { notifyOrderStatus: jest.fn() } as any;
  const svc = new AdminService(
    client,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    notifications,
  );
  return { svc, client, rows, atTransactionClose, notifications };
}

const statusOf = (rows: Row[], id: string) => rows.find((r) => r.id === id)!.status;

describe('withdrawing a provider approval cancels the orders it can still reach', () => {
  it.each([['SUSPENDED'], ['REVOKED']])(
    'cancels every pre-chain order held by a provider being %s',
    async (status) => {
      const { svc, rows } = build();

      await svc.setStatus(LP_ID, status as any, 'stood down', 'GADMINTEST');

      expect(statusOf(rows, 'created')).toBe('CANCELLED');
      expect(statusOf(rows, 'matched')).toBe('CANCELLED');
      expect(statusOf(rows, 'awaiting')).toBe('CANCELLED');
    },
  );

  it.each([['funded'], ['fiat-paid'], ['released']])(
    'leaves the %s order alone, because its money is already on chain',
    async (id) => {
      const { svc, rows } = build();
      const before = statusOf(rows, id);

      await svc.setStatus(LP_ID, 'REVOKED', 'stood down', 'GADMINTEST');

      expect(statusOf(rows, id)).toBe(before);
    },
  );

  it('leaves another provider’s matched order alone', async () => {
    const { svc, rows } = build();

    await svc.setStatus(LP_ID, 'REVOKED', 'stood down', 'GADMINTEST');

    expect(statusOf(rows, 'other-lp-matched')).toBe('MATCHED');
  });

  it('cancels nothing when the provider is being APPROVED', async () => {
    const { svc, client, rows } = build('PENDING');

    await svc.setStatus(LP_ID, 'APPROVED', 'welcome', 'GADMINTEST');

    expect(client.order.updateMany).not.toHaveBeenCalled();
    expect(statusOf(rows, 'matched')).toBe('MATCHED');
  });

  it('has already cancelled them by the moment the status transaction closes', async () => {
    const { svc, atTransactionClose } = build();

    await svc.setStatus(LP_ID, 'REVOKED', 'stood down', 'GADMINTEST');

    expect(atTransactionClose).not.toHaveLength(0);
    expect(statusOf(atTransactionClose, 'matched')).toBe('CANCELLED');
  });

  it('writes only to the orders the read returned, and only while they are still pre-chain', async () => {
    const { svc, client } = build();

    await svc.setStatus(LP_ID, 'REVOKED', 'stood down', 'GADMINTEST');

    expect(client.order.updateMany).toHaveBeenCalledTimes(1);
    expect(client.order.updateMany.mock.calls[0][0]).toEqual({
      where: {
        id: { in: ['created', 'matched', 'awaiting'] },
        status: { in: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN'] },
      },
      data: { status: 'CANCELLED' },
    });
  });

  it('tells each affected party their order was cancelled', async () => {
    const { svc, notifications } = build();

    await svc.setStatus(LP_ID, 'REVOKED', 'stood down', 'GADMINTEST');

    expect(notifications.notifyOrderStatus).toHaveBeenCalledTimes(3);
    const ids = notifications.notifyOrderStatus.mock.calls.map((c: any[]) => c[0].id).sort();
    expect(ids).toEqual(['awaiting', 'created', 'matched']);
    expect(notifications.notifyOrderStatus.mock.calls[0][1]).toBe('CANCELLED');
  });

  it('still returns the updated provider when a notification fails', async () => {
    const { svc, notifications } = build();
    notifications.notifyOrderStatus.mockRejectedValue(new Error('smtp down'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(svc.setStatus(LP_ID, 'REVOKED', 'stood down', 'GADMINTEST')).resolves.toMatchObject({
      status: 'REVOKED',
    });
  });
});

describe('an order that moves on between the read and the write is never announced as cancelled', () => {
  const racing = () => build('APPROVED', { id: 'awaiting', to: 'FUNDED' });

  it('refuses the stand-down when the write reaches fewer orders than the read returned', async () => {
    const { svc } = racing();

    await expect(svc.setStatus(LP_ID, 'REVOKED', 'stood down', 'GADMINTEST')).rejects.toThrow(
      ConflictException,
    );
  });

  it('tells nobody their order was cancelled, because one of the orders read was not cancelled', async () => {
    const { svc, notifications } = racing();

    await svc.setStatus(LP_ID, 'REVOKED', 'stood down', 'GADMINTEST').catch(() => undefined);

    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('writes no audit row naming an order the write never reached', async () => {
    const { svc, client } = racing();

    await svc.setStatus(LP_ID, 'REVOKED', 'stood down', 'GADMINTEST').catch(() => undefined);

    expect(client.adminAudit.create).not.toHaveBeenCalled();
  });

  it('leaves the order that moved on at FUNDED, where its escrow is', async () => {
    const { svc, rows } = racing();

    await svc.setStatus(LP_ID, 'REVOKED', 'stood down', 'GADMINTEST').catch(() => undefined);

    expect(statusOf(rows, 'awaiting')).toBe('FUNDED');
  });
});
