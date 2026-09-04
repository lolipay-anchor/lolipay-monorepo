import { Logger } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';

function makeSvc(delayMs: number) {
  let concurrent = 0;
  let maxConcurrent = 0;
  let runs = 0;

  const prisma = {
    order: {
      findMany: jest.fn(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        runs += 1;
        await new Promise((r) => setTimeout(r, delayMs));
        concurrent -= 1;
        return [];
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    config: { findUnique: jest.fn().mockResolvedValue({ id: 1, autoRefund: false }) },
    quote: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    walletLinkChallenge: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    sep10ConsumedChallenge: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  } as any;

  const svc = new MaintenanceService(
    prisma,
    { getTradeStatusStrict: jest.fn(async () => null), latestLedgerCloseTime: jest.fn(async () => new Date()) } as any,
    { isConfigured: false } as any,
    { escrowContractId: 'CESCROW' } as any,
    { notifyOrderStatus: jest.fn() } as any,
    { raise: jest.fn(async () => ({ sent: [], cleared: [] })) } as any,
    { prune: jest.fn(async () => 0), stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })) } as any,
  );

  return { svc, maxConcurrent: () => maxConcurrent, runs: () => runs };
}

describe('a slow cron must not run on top of itself', () => {
  it('lets only one divergence scan run at a time', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, maxConcurrent, runs } = makeSvc(30);

    await Promise.all([
      svc.alertOnEscrowDivergence(),
      svc.alertOnEscrowDivergence(),
      svc.alertOnEscrowDivergence(),
    ]);

    expect(maxConcurrent()).toBe(1);
    expect(runs()).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still running'));
    warn.mockRestore();
  });

  it('runs again once the previous tick has finished', async () => {
    const { svc, runs } = makeSvc(1);
    await svc.alertOnEscrowDivergence();
    await svc.alertOnEscrowDivergence();
    expect(runs()).toBe(2);
  });

  it('does not let one slow cron block a different one', async () => {
    const { svc, runs } = makeSvc(20);
    await Promise.all([svc.alertOnEscrowDivergence(), svc.expireStaleOrders()]);
    expect(runs()).toBe(2);
  });

  it('releases the guard even when the tick throws', async () => {
    const { svc } = makeSvc(1);
    (svc as any).run_alertOnEscrowDivergence = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    await expect(svc.alertOnEscrowDivergence()).rejects.toThrow('boom');
    await expect(svc.alertOnEscrowDivergence()).resolves.toBeUndefined();
    expect((svc as any).run_alertOnEscrowDivergence).toHaveBeenCalledTimes(2);
  });
});
