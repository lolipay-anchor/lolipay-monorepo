import { NotFoundException } from '@nestjs/common';
import { LpService } from './lp.service';

const LP_ADDR = 'GLPWALLET';
const LP_ID = 'lp-1';

function makeEarningsPrisma(
  opts: {
    lp?: any;
    todayRows?: { usdcAmount: bigint; lpFeeBps: number }[];
    weekRows?: { day: string; volume: string; earned: string }[];
    allTimeTrades?: number;
    allTimeEarned?: string | null;
  } = {},
) {
  const lp = {
    findUnique: jest.fn().mockResolvedValue(
      'lp' in opts ? opts.lp : { id: LP_ID, stellarAddress: LP_ADDR },
    ),
  };
  const order = {
    findMany: jest.fn().mockResolvedValue(opts.todayRows ?? []),
    count: jest.fn().mockResolvedValue(opts.allTimeTrades ?? 0),
  };
  const $queryRaw = jest.fn((sql: any) => {
    const text = String(sql?.sql ?? sql?.text ?? sql);
    if (text.includes('GROUP BY')) return Promise.resolve(opts.weekRows ?? []);
    return Promise.resolve([{ earned: opts.allTimeEarned ?? null }]);
  });
  return { lp, order, $queryRaw } as any;
}

function makeSvc(prisma: any) {
  return new LpService(prisma, {} as any);
}

describe('LpService.getEarnings', () => {
  afterEach(() => jest.useRealTimers());

  it('throws NotFoundException when the authed address has no Lp row (defensive — should not happen given @Roles(lp))', async () => {
    const prisma = makeEarningsPrisma({ lp: null });
    const svc = makeSvc(prisma);

    await expect(svc.getEarnings(LP_ADDR)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('resolves the authed address to exactly this LP\'s id — never trusts a client-supplied id', async () => {
    const prisma = makeEarningsPrisma({ todayRows: [], allTimeTrades: 0 });
    const svc = makeSvc(prisma);

    await svc.getEarnings(LP_ADDR);

    expect(prisma.lp.findUnique).toHaveBeenCalledWith({ where: { stellarAddress: LP_ADDR } });
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ lpId: LP_ID, status: 'RELEASED' }) }),
    );
    expect(prisma.order.count).toHaveBeenCalledWith({ where: { lpId: LP_ID, status: 'RELEASED' } });
  });

  it('today_trades/today_volume_usdc/today_earned_usdc: exact per-row BigInt lp-fee math, summed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T15:30:00.000Z'));
    const prisma = makeEarningsPrisma({
      todayRows: [
        { usdcAmount: 100_0000000n, lpFeeBps: 120 },
        { usdcAmount: 50_0000000n, lpFeeBps: 120 },
      ],
    });
    const svc = makeSvc(prisma);

    const e = await svc.getEarnings(LP_ADDR);

    expect(e.todayTrades).toBe(2);
    expect(e.todayVolumeUsdc).toBe(150);
    expect(e.todayEarnedUsdc).toBeCloseTo(1.8, 7);
  });

  it('today_earned_usdc stays exact (integer base-unit division) for a bps split that would round unevenly as a float', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T00:00:01.000Z'));
    const prisma = makeEarningsPrisma({
      todayRows: [{ usdcAmount: 1_0000001n, lpFeeBps: 17 }],
    });
    const svc = makeSvc(prisma);

    const e = await svc.getEarnings(LP_ADDR);

    const expectedBase = (1_0000001n * 17n) / 10_000n;
    expect(e.todayEarnedUsdc).toBeCloseTo(Number(expectedBase) / 1e7, 10);
  });

  it('"today" is scoped to the UTC calendar day — findMany is called with settledAt >= UTC midnight', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T23:59:59.000Z'));
    const prisma = makeEarningsPrisma();
    const svc = makeSvc(prisma);

    await svc.getEarnings(LP_ADDR);

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          settledAt: { gte: new Date('2026-07-08T00:00:00.000Z') },
        }),
      }),
    );
  });

  it('week_bars: 7 ascending days (today inclusive), zero-filled for days with no rows', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
    const prisma = makeEarningsPrisma({
      weekRows: [
        { day: '2026-07-08', volume: '1000000000', earned: '12000000' },
        { day: '2026-07-05', volume: '200000000', earned: '2000000' },
      ],
    });
    const svc = makeSvc(prisma);

    const e = await svc.getEarnings(LP_ADDR);

    expect(e.weekBars.map((b) => b.date)).toEqual([
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
    ]);
    expect(e.weekBars.find((b) => b.date === '2026-07-08')).toEqual({
      date: '2026-07-08',
      volumeUsdc: 100,
      earnedUsdc: 1.2,
    });
    expect(e.weekBars.find((b) => b.date === '2026-07-05')).toEqual({
      date: '2026-07-05',
      volumeUsdc: 20,
      earnedUsdc: 0.2,
    });

    expect(e.weekBars.find((b) => b.date === '2026-07-02')).toEqual({
      date: '2026-07-02',
      volumeUsdc: 0,
      earnedUsdc: 0,
    });
  });

  it('week_bars $queryRaw is parameterized with this LP\'s id and the 7-day window start (never raw-interpolated)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
    const prisma = makeEarningsPrisma();
    const svc = makeSvc(prisma);

    await svc.getEarnings(LP_ADDR);

    const weekCall = prisma.$queryRaw.mock.calls.find((c: any) => String(c[0].sql).includes('GROUP BY'));
    expect(weekCall).toBeDefined();
    const sql = weekCall[0];
    expect(sql.sql).not.toContain(LP_ID);
    expect(sql.values).toContain(LP_ID);
    expect(sql.values).toContainEqual(new Date('2026-07-02T00:00:00.000Z'));
  });

  it('week_bars SQL uses plain date_trunc (no AT TIME ZONE) over the naive-UTC settledAt column', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
    const prisma = makeEarningsPrisma();
    const svc = makeSvc(prisma);

    await svc.getEarnings(LP_ADDR);

    const weekCall = prisma.$queryRaw.mock.calls.find((c: any) => String(c[0].sql).includes('GROUP BY'));
    expect(weekCall).toBeDefined();
    expect(weekCall[0].sql).toContain(`date_trunc('day', "settledAt")`);
    expect(weekCall[0].sql).not.toContain('AT TIME ZONE');
  });

  it('week_bars is empty → all 7 bars zeroed (not an empty array — the sparkline always renders 7 points)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
    const prisma = makeEarningsPrisma({ weekRows: [] });
    const svc = makeSvc(prisma);

    const e = await svc.getEarnings(LP_ADDR);

    expect(e.weekBars).toHaveLength(7);
    expect(e.weekBars.every((b) => b.volumeUsdc === 0 && b.earnedUsdc === 0)).toBe(true);
  });

  it('all_time_trades/all_time_earned_usdc reflect the count + raw-SQL fee sum', async () => {
    const prisma = makeEarningsPrisma({ allTimeTrades: 42, allTimeEarned: '50000000' });
    const svc = makeSvc(prisma);

    const e = await svc.getEarnings(LP_ADDR);

    expect(e.allTimeTrades).toBe(42);
    expect(e.allTimeEarnedUsdc).toBe(5);
  });

  it('all_time_earned_usdc is 0 (not NaN/null) when the LP has no RELEASED orders ever (SQL SUM of zero rows is NULL)', async () => {
    const prisma = makeEarningsPrisma({ allTimeTrades: 0, allTimeEarned: null });
    const svc = makeSvc(prisma);

    const e = await svc.getEarnings(LP_ADDR);

    expect(e.allTimeEarnedUsdc).toBe(0);
  });

  it('brand-new LP with zero orders ever → every numeric field is 0, week_bars has 7 zeroed entries (never null)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
    const prisma = makeEarningsPrisma({
      todayRows: [],
      weekRows: [],
      allTimeTrades: 0,
      allTimeEarned: null,
    });
    const svc = makeSvc(prisma);

    const e = await svc.getEarnings(LP_ADDR);

    expect(e).toEqual({
      todayTrades: 0,
      todayEarnedUsdc: 0,
      todayVolumeUsdc: 0,
      weekBars: [
        { date: '2026-07-02', volumeUsdc: 0, earnedUsdc: 0 },
        { date: '2026-07-03', volumeUsdc: 0, earnedUsdc: 0 },
        { date: '2026-07-04', volumeUsdc: 0, earnedUsdc: 0 },
        { date: '2026-07-05', volumeUsdc: 0, earnedUsdc: 0 },
        { date: '2026-07-06', volumeUsdc: 0, earnedUsdc: 0 },
        { date: '2026-07-07', volumeUsdc: 0, earnedUsdc: 0 },
        { date: '2026-07-08', volumeUsdc: 0, earnedUsdc: 0 },
      ],
      allTimeTrades: 0,
      allTimeEarnedUsdc: 0,
    });
  });
});
