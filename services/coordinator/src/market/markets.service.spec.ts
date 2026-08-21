import { BadRequestException } from '@nestjs/common';
import { MarketsService, SEED_MARKETS } from './markets.service';

function makePrisma(overrides: Record<string, any> = {}) {
  const marketRow = {
    code: 'IDR',
    country: 'Indonesia',
    currencySymbol: 'Rp',
    locale: 'id-ID',
    railName: 'QRIS',
    rateSource: 'coingecko',
    manualRateOverride: null,
    priceMinPerUsdc: '5000',
    priceMaxPerUsdc: '50000',
    decimals: 0,
    enabled: true,
    updatedAt: new Date(),
  };
  const market = {
    findUnique: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([marketRow]),
    upsert: jest.fn().mockResolvedValue(marketRow),
    update: jest.fn().mockResolvedValue(marketRow),
    ...overrides.market,
  };
  const config = {
    findUnique: jest.fn().mockResolvedValue({ id: 1 }),
    update: jest.fn().mockResolvedValue({ id: 1 }),
    ...overrides.config,
  };
  return {
    market,
    config,

    $transaction: jest.fn((cb: any) => cb({ market, config })),
  } as any;
}

describe('MarketsService.seed', () => {
  it('upserts all 6 seed corridors idempotently (update: {} never clobbers)', async () => {
    const prisma = makePrisma();
    const svc = new MarketsService(prisma);

    await svc.seed();
    await svc.seed();

    expect(prisma.market.upsert).toHaveBeenCalledTimes(SEED_MARKETS.length * 2);
    for (const call of prisma.market.upsert.mock.calls) {
      expect(call[0].update).toEqual({});
    }
    const codes = SEED_MARKETS.map((m) => m.code);
    expect(codes).toEqual(['IDR', 'PHP', 'VND', 'INR', 'THB', 'BRL']);
  });

  it('only IDR is seeded enabled=true; the rest are enabled=false', () => {
    const idr = SEED_MARKETS.find((m) => m.code === 'IDR')!;
    const others = SEED_MARKETS.filter((m) => m.code !== 'IDR');
    expect(idr.enabled).toBe(true);
    for (const m of others) expect(m.enabled).toBe(false);
  });

  it('decimal corridors (PHP/INR/THB/BRL) are seeded with decimals=2, IDR/VND with decimals=0', () => {
    const byCode = Object.fromEntries(SEED_MARKETS.map((m) => [m.code, m]));
    expect(byCode.IDR.decimals).toBe(0);
    expect(byCode.VND.decimals).toBe(0);
    expect(byCode.PHP.decimals).toBe(2);
    expect(byCode.INR.decimals).toBe(2);
    expect(byCode.THB.decimals).toBe(2);
    expect(byCode.BRL.decimals).toBe(2);
  });

});

describe('MarketsService.getEnabled', () => {
  it('returns the market row when it exists and is enabled', async () => {
    const prisma = makePrisma({
      market: {
        findMany: jest.fn().mockResolvedValue([
          { code: 'IDR', enabled: true, decimals: 0 },
        ]),
      },
    });
    const svc = new MarketsService(prisma);
    const m = await svc.getEnabled('IDR');
    expect(m.code).toBe('IDR');
  });

  it('throws BadRequestException for an unknown code', async () => {
    const prisma = makePrisma({ market: { findMany: jest.fn().mockResolvedValue([]) } });
    const svc = new MarketsService(prisma);
    await expect(svc.getEnabled('ZZZ')).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException for a known but disabled code', async () => {
    const prisma = makePrisma({
      market: {
        findMany: jest.fn().mockResolvedValue([
          { code: 'PHP', enabled: false, decimals: 2 },
        ]),
      },
    });
    const svc = new MarketsService(prisma);
    await expect(svc.getEnabled('PHP')).rejects.toThrow(BadRequestException);
  });
});

describe('MarketsService.update', () => {
  it('rejects enabling a market whose decimals > 0', async () => {
    const prisma = makePrisma({
      market: {
        findUnique: jest.fn().mockResolvedValue({ code: 'PHP', enabled: false, decimals: 2 }),
      },
    });
    const svc = new MarketsService(prisma);
    await expect(svc.update('PHP', { enabled: true })).rejects.toThrow(BadRequestException);
    expect(prisma.market.update).not.toHaveBeenCalled();
  });

  it('rejects when the patch itself sets decimals > 0 while enabling', async () => {
    const prisma = makePrisma({
      market: {
        findUnique: jest.fn().mockResolvedValue({ code: 'PHP', enabled: false, decimals: 0 }),
      },
    });
    const svc = new MarketsService(prisma);
    await expect(svc.update('PHP', { enabled: true, decimals: 2 } as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('allows enabling a market whose decimals are 0', async () => {
    const prisma = makePrisma({
      market: {
        findUnique: jest.fn().mockResolvedValue({
          code: 'VND', enabled: false, decimals: 0, priceMinPerUsdc: '15000', priceMaxPerUsdc: '40000',
        }),
        update: jest.fn().mockResolvedValue({ code: 'VND', enabled: true, decimals: 0 }),
      },
    });
    const svc = new MarketsService(prisma);
    const updated = await svc.update('VND', { enabled: true });
    expect(updated.enabled).toBe(true);
  });

  it('allows a non-enabling patch (e.g. bounds change) regardless of decimals', async () => {
    const prisma = makePrisma({
      market: {
        findUnique: jest.fn().mockResolvedValue({
          code: 'PHP', enabled: false, decimals: 2, priceMinPerUsdc: '30', priceMaxPerUsdc: '120',
        }),
        update: jest.fn().mockResolvedValue({ code: 'PHP', enabled: false, decimals: 2 }),
      },
    });
    const svc = new MarketsService(prisma);
    await expect(svc.update('PHP', { priceMinPerUsdc: '31' })).resolves.toBeDefined();
  });

  it('throws BadRequestException for an unknown code', async () => {
    const prisma = makePrisma({ market: { findUnique: jest.fn().mockResolvedValue(null) } });
    const svc = new MarketsService(prisma);
    await expect(svc.update('ZZZ', { enabled: true })).rejects.toThrow(BadRequestException);
  });

  it('reads the current row via $transaction/tx.market.findUnique, never the cache', async () => {
    const prisma = makePrisma({
      market: {
        findUnique: jest.fn().mockResolvedValue({
          code: 'IDR',
          enabled: true,
          decimals: 0,
          priceMinPerUsdc: '5000',
          priceMaxPerUsdc: '50000',
        }),
      },
    });
    const svc = new MarketsService(prisma);

    await svc.update('IDR', { railName: 'QRIS2' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.market.findUnique).toHaveBeenCalledWith({ where: { code: 'IDR' } });

    expect(prisma.market.findMany).not.toHaveBeenCalled();
  });

  it('a stale cached list() does not stop a concurrent bad-bounds PATCH from being rejected', async () => {
    const prisma = makePrisma({
      market: {
        findMany: jest.fn().mockResolvedValue([
          { code: 'IDR', enabled: true, decimals: 0, priceMinPerUsdc: '5000', priceMaxPerUsdc: '50000' },
        ]),

        findUnique: jest.fn().mockResolvedValue({
          code: 'IDR',
          enabled: true,
          decimals: 0,
          priceMinPerUsdc: '50000',
          priceMaxPerUsdc: '50000',
        }),
      },
    });
    const svc = new MarketsService(prisma);

    await svc.list();
    await expect(svc.update('IDR', { railName: 'QRIS2' })).rejects.toThrow(BadRequestException);
  });

  it('rejects priceMinPerUsdc <= 0', async () => {
    const prisma = makePrisma({
      market: {
        findUnique: jest.fn().mockResolvedValue({
          code: 'IDR', enabled: true, decimals: 0, priceMinPerUsdc: '5000', priceMaxPerUsdc: '50000',
        }),
      },
    });
    const svc = new MarketsService(prisma);
    await expect(svc.update('IDR', { priceMinPerUsdc: '0' })).rejects.toThrow(BadRequestException);
    expect(prisma.market.update).not.toHaveBeenCalled();
  });

  it('rejects an inverted range (min >= max)', async () => {
    const prisma = makePrisma({
      market: {
        findUnique: jest.fn().mockResolvedValue({
          code: 'IDR', enabled: true, decimals: 0, priceMinPerUsdc: '5000', priceMaxPerUsdc: '50000',
        }),
      },
    });
    const svc = new MarketsService(prisma);
    await expect(
      svc.update('IDR', { priceMinPerUsdc: '9000', priceMaxPerUsdc: '9000' }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.market.update).not.toHaveBeenCalled();
  });

  it('rejects a ratio > 10 (degenerate-wide bounds that would neuter assertPlausible)', async () => {
    const prisma = makePrisma({
      market: {
        findUnique: jest.fn().mockResolvedValue({
          code: 'IDR', enabled: true, decimals: 0, priceMinPerUsdc: '5000', priceMaxPerUsdc: '50000',
        }),
      },
    });
    const svc = new MarketsService(prisma);
    await expect(
      svc.update('IDR', { priceMinPerUsdc: '1', priceMaxPerUsdc: '100' }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.market.update).not.toHaveBeenCalled();
  });

  it('accepts a ratio of exactly 10 (inclusive) — matches the IDR seed bounds 5000/50000', async () => {
    const prisma = makePrisma({
      market: {
        findUnique: jest.fn().mockResolvedValue({
          code: 'IDR', enabled: true, decimals: 0, priceMinPerUsdc: '5000', priceMaxPerUsdc: '50000',
        }),
        update: jest.fn().mockResolvedValue({
          code: 'IDR', enabled: true, decimals: 0, priceMinPerUsdc: '5000', priceMaxPerUsdc: '50000',
        }),
      },
    });
    const svc = new MarketsService(prisma);
    await expect(
      svc.update('IDR', { priceMinPerUsdc: '5000', priceMaxPerUsdc: '50000' }),
    ).resolves.toBeDefined();
    expect(prisma.market.update).toHaveBeenCalled();
  });

  it('all 6 seeded corridors pass the ratio<=10 guard unpatched (no bounds field in the patch)', async () => {
    for (const seed of SEED_MARKETS) {
      const prisma = makePrisma({
        market: {
          findUnique: jest.fn().mockResolvedValue({
            code: seed.code,
            enabled: seed.enabled,
            decimals: seed.decimals,
            priceMinPerUsdc: seed.priceMinPerUsdc,
            priceMaxPerUsdc: seed.priceMaxPerUsdc,
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      });
      const svc = new MarketsService(prisma);
      await expect(svc.update(seed.code, { railName: seed.railName })).resolves.toBeDefined();
    }
  });

  it('re-validates bounds even when the patch does not touch them (self-heals against a corrupt row)', async () => {
    const prisma = makePrisma({
      market: {
        findUnique: jest.fn().mockResolvedValue({
          code: 'IDR', enabled: true, decimals: 0, priceMinPerUsdc: '0', priceMaxPerUsdc: '50000',
        }),
      },
    });
    const svc = new MarketsService(prisma);
    await expect(svc.update('IDR', { railName: 'QRIS2' })).rejects.toThrow(BadRequestException);
    expect(prisma.market.update).not.toHaveBeenCalled();
  });
});

describe('MarketsService in-process cache (5s TTL)', () => {
  it('serves list() from cache within the TTL window without re-querying the DB', async () => {
    const prisma = makePrisma();
    const svc = new MarketsService(prisma);

    await svc.list();
    await svc.list();
    await svc.list();

    expect(prisma.market.findMany).toHaveBeenCalledTimes(1);
  });

  it('re-queries the DB once the cache is invalidated (e.g. after seed())', async () => {
    const prisma = makePrisma();
    const svc = new MarketsService(prisma);

    await svc.list();
    await svc.seed();
    await svc.list();

    expect(prisma.market.findMany).toHaveBeenCalledTimes(2);
  });

  it('re-queries the DB once the cache expires past the 5s TTL', async () => {
    jest.useFakeTimers();
    try {
      const prisma = makePrisma();
      const svc = new MarketsService(prisma);

      await svc.list();
      jest.advanceTimersByTime(5001);
      await svc.list();

      expect(prisma.market.findMany).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
