import { computeQuoteFields, QUOTE_TTL_MS, RateService } from './rate.service';
import { MarketsService } from '../market/markets.service';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

describe('computeQuoteFields', () => {
  it('produces fiat + fee bps from price/spread/config', () => {
    const q = computeQuoteFields(1_000_000_000n, '16000', {
      spreadBps: 150,
      platformFeeBps: 30,
      lpFeeBps: 120,
    });
    expect(q.fiatAmount).toBe(1_624_000n);
    expect(q.platformFeeBps).toBe(30);
    expect(q.lpFeeBps).toBe(120);
  });

  it('returns rateSnapshot matching input price', () => {
    const q = computeQuoteFields(1_000_000_000n, '16000', {
      spreadBps: 0,
      platformFeeBps: 0,
      lpFeeBps: 0,
    });
    expect(q.rateSnapshot).toBe('16000');
  });

  it('applies the spread in the correct direction per flow (buy adds, sell subtracts)', () => {
    const cfg = { spreadBps: 150, platformFeeBps: 30, lpFeeBps: 120 };
    const mid = 1_600_000n;
    const buy = computeQuoteFields(1_000_000_000n, '16000', cfg, 'TOP_UP');
    const sellW = computeQuoteFields(1_000_000_000n, '16000', cfg, 'WITHDRAW');
    const sellQ = computeQuoteFields(1_000_000_000n, '16000', cfg, 'WITHDRAW');
    expect(buy.fiatAmount).toBe(1_624_000n);
    expect(sellW.fiatAmount).toBe(1_576_000n);
    expect(sellQ.fiatAmount).toBe(sellW.fiatAmount);

    expect(sellW.fiatAmount < mid && mid < buy.fiatAmount).toBe(true);
  });
});

const mockCfg = {
  priceStaleSecs: 120,
  priceDeviationMaxBps: 500,
  adminAddresses: ['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'],
} as any;

function makeMarketRow(overrides: Record<string, any> = {}) {
  return {
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
    ...overrides,
  };
}

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    fiatPriceCache: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined),
      ...overrides.fiatPriceCache,
    },
    market: {
      findMany: jest.fn().mockResolvedValue([makeMarketRow()]),
      ...overrides.market,
    },
    config: {
      upsert: jest.fn().mockResolvedValue({
        id: 1,
        spreadBps: 150,
        platformFeeBps: 30,
        lpFeeBps: 120,
        minOrder: 50_000_000n,
        maxOrder: 10_000_000_000n,
        paused: false,
        manualRateOverride: null,
        platformWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      }),
      ...overrides.config,
    },
    quote: {
      create: jest.fn().mockResolvedValue({ id: 'q1', fiatAmount: 1_624_000n, fiatCurrency: 'IDR' }),
      ...overrides.quote,
    },
  } as any;
}

function makeReputationStub(overrides: Record<string, any> = {}) {
  return {
    personIdFor: jest.fn().mockResolvedValue('person-test'),
    getReputation: jest.fn().mockResolvedValue({
      tier: 'BRONZE',
      completedTrades: 0,
      disputesLost: 0,
      completionRate: null,
    }),
    dailyLimitBaseUnits: jest.fn().mockReturnValue(1_000_000_000n),
    used24hBaseUnits: jest.fn().mockResolvedValue(0n),
    ...overrides,
  } as any;
}

function makeSvc(prisma: any, adapter: any, cfg: any = mockCfg, userReputation: any = makeReputationStub()) {
  const markets = new MarketsService(prisma);
  return new RateService(prisma, cfg, adapter, markets, userReputation);
}

describe('RateService.getReferencePrice', () => {
  it('returns a per-market manual override without calling the adapter', async () => {
    const prisma = makePrisma({
      market: { findMany: jest.fn().mockResolvedValue([makeMarketRow({ manualRateOverride: '17000' })]) },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn() };
    const svc = makeSvc(prisma, adapter);
    const price = await svc.getReferencePrice('IDR');
    expect(price).toBe('17000');
    expect(adapter.fetchPrices).not.toHaveBeenCalled();
  });

  it('uses a manual override for a NON-IDR corridor without calling the adapter', async () => {
    const prisma = makePrisma({
      market: {
        findMany: jest.fn().mockResolvedValue([
          makeMarketRow({
            code: 'VND',
            manualRateOverride: '25000',
            priceMinPerUsdc: '15000',
            priceMaxPerUsdc: '40000',
          }),
        ]),
      },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn() };
    const svc = makeSvc(prisma, adapter);
    const price = await svc.getReferencePrice('VND');
    expect(price).toBe('25000');
    expect(adapter.fetchPrices).not.toHaveBeenCalled();
  });

  it('read-through: serves a FRESH cached price without calling the adapter', async () => {
    const freshFetchedAt = new Date(Date.now() - 10_000);
    const prisma = makePrisma({
      fiatPriceCache: {
        findUnique: jest.fn().mockResolvedValue({
          fiat: 'IDR', source: 'coingecko', pricePerUsdc: '16000', fetchedAt: freshFetchedAt,
        }),
        upsert: jest.fn(),
      },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn() };
    const svc = makeSvc(prisma, adapter);
    const price = await svc.getReferencePrice('IDR');
    expect(price).toBe('16000');
    expect(adapter.fetchPrices).not.toHaveBeenCalled();
    expect(prisma.fiatPriceCache.upsert).not.toHaveBeenCalled();
  });

  it('throws 503 price anomaly when a refreshed price deviates beyond max bps', async () => {
    const staleFetchedAt = new Date(Date.now() - 200_000);
    const prisma = makePrisma({
      fiatPriceCache: {
        findUnique: jest.fn().mockResolvedValue({
          fiat: 'IDR', source: 'coingecko', pricePerUsdc: '16000', fetchedAt: staleFetchedAt,
        }),
        upsert: jest.fn(),
      },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ IDR: '17000' }) };
    const svc = makeSvc(prisma, adapter);
    await expect(svc.getReferencePrice('IDR')).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.fiatPriceCache.upsert).not.toHaveBeenCalled();
  });

  it('accepts the new level once a second fetch agrees with the one it refused', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const staleFetchedAt = new Date(Date.now() - 200_000);
    const prisma = makePrisma({
      fiatPriceCache: {
        findUnique: jest.fn().mockResolvedValue({
          fiat: 'IDR', source: 'coingecko', pricePerUsdc: '16000', fetchedAt: staleFetchedAt,
        }),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ IDR: '17000' }) };
    const svc = makeSvc(prisma, adapter);

    await expect(svc.getReferencePrice('IDR')).rejects.toThrow('price anomaly');
    await expect(svc.getReferencePrice('IDR')).resolves.toBe('17000');

    expect(prisma.fiatPriceCache.upsert).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('holding quotes until a second fetch agrees'));
    err.mockRestore();
  });

  it('keeps refusing while each fetch disagrees with the one before it', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const staleFetchedAt = new Date(Date.now() - 200_000);
    const prisma = makePrisma({
      fiatPriceCache: {
        findUnique: jest.fn().mockResolvedValue({
          fiat: 'IDR', source: 'coingecko', pricePerUsdc: '16000', fetchedAt: staleFetchedAt,
        }),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    });
    const prices = ['17000', '18500', '20000'];
    const adapter = {
      name: 'mock',
      fetchPrices: jest.fn().mockImplementation(async () => ({ IDR: prices.shift() as string })),
    };
    const svc = makeSvc(prisma, adapter);

    await expect(svc.getReferencePrice('IDR')).rejects.toThrow('price anomaly');
    await expect(svc.getReferencePrice('IDR')).rejects.toThrow('price anomaly');
    await expect(svc.getReferencePrice('IDR')).rejects.toThrow('price anomaly');

    expect(prisma.fiatPriceCache.upsert).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('forgets the refused observation once a price inside the band arrives', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const staleFetchedAt = new Date(Date.now() - 200_000);
    const prisma = makePrisma({
      fiatPriceCache: {
        findUnique: jest.fn().mockResolvedValue({
          fiat: 'IDR', source: 'coingecko', pricePerUsdc: '16000', fetchedAt: staleFetchedAt,
        }),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    });
    const prices = ['17000', '16050', '17000'];
    const adapter = {
      name: 'mock',
      fetchPrices: jest.fn().mockImplementation(async () => ({ IDR: prices.shift() as string })),
    };
    const svc = makeSvc(prisma, adapter);

    await expect(svc.getReferencePrice('IDR')).rejects.toThrow('price anomaly');
    await expect(svc.getReferencePrice('IDR')).resolves.toBe('16050');
    await expect(svc.getReferencePrice('IDR')).rejects.toThrow('price anomaly');
    err.mockRestore();
  });

  it('accepts a refreshed price within allowed deviation of the cached value', async () => {
    const staleFetchedAt = new Date(Date.now() - 200_000);
    const prisma = makePrisma({
      fiatPriceCache: {
        findUnique: jest.fn().mockResolvedValue({
          fiat: 'IDR', source: 'coingecko', pricePerUsdc: '16000', fetchedAt: staleFetchedAt,
        }),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16050' }) };
    const svc = makeSvc(prisma, adapter);
    const price = await svc.getReferencePrice('IDR');
    expect(price).toBe('16050');
  });

  it('falls back to stale cache when adapter throws and cache is still fresh', async () => {
    const freshFetchedAt = new Date(Date.now() - 10_000);
    const prisma = makePrisma({
      fiatPriceCache: {
        findUnique: jest.fn().mockResolvedValue({
          fiat: 'IDR',
          source: 'coingecko',
          pricePerUsdc: '16000',
          fetchedAt: freshFetchedAt,
        }),
        upsert: jest.fn(),
      },
    });
    const adapter = {
      name: 'mock',
      fetchPrices: jest.fn().mockRejectedValue(new Error('network error')),
    };
    const svc = makeSvc(prisma, adapter);
    const price = await svc.getReferencePrice('IDR');
    expect(price).toBe('16000');
  });

  it('throws 503 when adapter throws and cache is truly stale (> priceStaleSecs)', async () => {
    const staleFetchedAt = new Date(Date.now() - 200_000);
    const prisma = makePrisma({
      fiatPriceCache: {
        findUnique: jest.fn().mockResolvedValue({
          fiat: 'IDR',
          source: 'coingecko',
          pricePerUsdc: '16000',
          fetchedAt: staleFetchedAt,
        }),
        upsert: jest.fn(),
      },
    });
    const adapter = {
      name: 'mock',
      fetchPrices: jest.fn().mockRejectedValue(new Error('network error')),
    };
    const svc = makeSvc(prisma, adapter);
    await expect(svc.getReferencePrice('IDR')).rejects.toThrow(ServiceUnavailableException);
    await expect(svc.getReferencePrice('IDR')).rejects.toThrow('price source unavailable');
  });

  it('rejects a source price below the plausible floor and does NOT cache it', async () => {
    const prisma = makePrisma();
    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ IDR: '3' }) };
    const svc = makeSvc(prisma, adapter);
    await expect(svc.getReferencePrice('IDR')).rejects.toThrow('price out of plausible bounds');
    expect(prisma.fiatPriceCache.upsert).not.toHaveBeenCalled();
  });

  it('rejects a source price above the plausible ceiling', async () => {
    const prisma = makePrisma();
    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ IDR: '900000' }) };
    const svc = makeSvc(prisma, adapter);
    await expect(svc.getReferencePrice('IDR')).rejects.toThrow('price out of plausible bounds');
    expect(prisma.fiatPriceCache.upsert).not.toHaveBeenCalled();
  });

  it('rejects an out-of-bounds manual override', async () => {
    const prisma = makePrisma({
      market: { findMany: jest.fn().mockResolvedValue([makeMarketRow({ manualRateOverride: '2' })]) },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn() };
    const svc = makeSvc(prisma, adapter);
    await expect(svc.getReferencePrice('IDR')).rejects.toThrow('price out of plausible bounds');
    expect(adapter.fetchPrices).not.toHaveBeenCalled();
  });

  it('ignores a malformed manualRateOverride and falls through to cache/refresh instead of 503ing', async () => {
    const freshFetchedAt = new Date(Date.now() - 10_000);
    const prisma = makePrisma({
      market: {
        findMany: jest.fn().mockResolvedValue([makeMarketRow({ manualRateOverride: 'not-a-number' })]),
      },
      fiatPriceCache: {
        findUnique: jest.fn().mockResolvedValue({
          fiat: 'IDR', source: 'coingecko', pricePerUsdc: '16000', fetchedAt: freshFetchedAt,
        }),
        upsert: jest.fn(),
      },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn() };
    const svc = makeSvc(prisma, adapter);
    const price = await svc.getReferencePrice('IDR');
    expect(price).toBe('16000');
    expect(adapter.fetchPrices).not.toHaveBeenCalled();
  });

  it('bounds are PER-MARKET: a price plausible for IDR is rejected for a corridor with a different scale', async () => {
    const prisma = makePrisma({
      market: {
        findMany: jest.fn().mockResolvedValue([
          makeMarketRow({ code: 'PHP', priceMinPerUsdc: '30', priceMaxPerUsdc: '120' }),
        ]),
      },
    });

    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ PHP: '16000' }) };
    const svc = makeSvc(prisma, adapter);
    await expect(svc.getReferencePrice('PHP')).rejects.toThrow('price out of plausible bounds');
  });

  it('throws BadRequestException for an unknown fiat code, without touching cache or adapter', async () => {
    const prisma = makePrisma({ market: { findMany: jest.fn().mockResolvedValue([]) } });
    const adapter = { name: 'mock', fetchPrices: jest.fn() };
    const svc = makeSvc(prisma, adapter);
    await expect(svc.getReferencePrice('ZZZ')).rejects.toThrow(BadRequestException);
    expect(prisma.fiatPriceCache.findUnique).not.toHaveBeenCalled();
    expect(adapter.fetchPrices).not.toHaveBeenCalled();
  });

  it('throws BadRequestException for a known but disabled fiat', async () => {
    const prisma = makePrisma({
      market: { findMany: jest.fn().mockResolvedValue([makeMarketRow({ code: 'PHP', enabled: false })]) },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn() };
    const svc = makeSvc(prisma, adapter);
    await expect(svc.getReferencePrice('PHP')).rejects.toThrow(BadRequestException);
    expect(adapter.fetchPrices).not.toHaveBeenCalled();
  });

  it('single-flight is PER FIAT: concurrent different fiats refresh independently (no head-of-line blocking)', async () => {
    const prisma = makePrisma({
      market: {
        findMany: jest.fn().mockResolvedValue([
          makeMarketRow({ code: 'IDR' }),
          makeMarketRow({ code: 'VND', priceMinPerUsdc: '15000', priceMaxPerUsdc: '40000' }),
        ]),
      },
    });
    let resolveIdr!: (v: any) => void;
    let resolveVnd!: (v: any) => void;
    const idrPromise = new Promise((res) => { resolveIdr = res; });
    const vndPromise = new Promise((res) => { resolveVnd = res; });
    const adapter = {
      name: 'mock',
      fetchPrices: jest.fn((fiats: string[]) => (fiats[0] === 'IDR' ? idrPromise : vndPromise)),
    };
    const svc = makeSvc(prisma, adapter);

    const pIdr = svc.getReferencePrice('IDR');
    const pVnd = svc.getReferencePrice('VND');

    resolveVnd({ VND: '20000' });
    await expect(pVnd).resolves.toBe('20000');

    resolveIdr({ IDR: '16000' });
    await expect(pIdr).resolves.toBe('16000');

    expect(adapter.fetchPrices).toHaveBeenCalledTimes(2);
    expect(adapter.fetchPrices).toHaveBeenCalledWith(['IDR']);
    expect(adapter.fetchPrices).toHaveBeenCalledWith(['VND']);
  });

  it('single-flight coalesces concurrent calls for the SAME fiat into one upstream call', async () => {
    const prisma = makePrisma();
    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) };
    const svc = makeSvc(prisma, adapter);

    const [a, b, c] = await Promise.all([
      svc.getReferencePrice('IDR'),
      svc.getReferencePrice('IDR'),
      svc.getReferencePrice('IDR'),
    ]);

    expect(a).toBe('16000');
    expect(b).toBe('16000');
    expect(c).toBe('16000');
    expect(adapter.fetchPrices).toHaveBeenCalledTimes(1);
  });
});

describe('RateService.getDisplayRate', () => {
  it('returns spread-applied rate > mid price (IDR, 150bps spread on 16000)', async () => {
    const prisma = makePrisma();
    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) };
    const svc = makeSvc(prisma, adapter);

    const rate = await svc.getDisplayRate('IDR');

    expect(rate).toBe('16240');
    expect(parseFloat(rate)).toBeGreaterThan(16000);
  });

  it('throws 503 when platform is paused, without calling the adapter', async () => {
    const prisma = makePrisma({
      config: {
        upsert: jest.fn().mockResolvedValue({
          id: 1, spreadBps: 150, platformFeeBps: 30, lpFeeBps: 120,
          minOrder: 50_000_000n, maxOrder: 10_000_000_000n, paused: true,
        }),
      },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn() };
    const svc = makeSvc(prisma, adapter);

    await expect(svc.getDisplayRate('IDR')).rejects.toThrow(ServiceUnavailableException);
    await expect(svc.getDisplayRate('IDR')).rejects.toThrow('paused');
    expect(adapter.fetchPrices).not.toHaveBeenCalled();
  });

  it('throws BadRequestException for a disabled fiat', async () => {
    const prisma = makePrisma({
      market: { findMany: jest.fn().mockResolvedValue([makeMarketRow({ code: 'PHP', enabled: false })]) },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn() };
    const svc = makeSvc(prisma, adapter);
    await expect(svc.getDisplayRate('PHP')).rejects.toThrow(BadRequestException);
  });
});

describe('RateService.createQuote', () => {
  it('defaults fiat to IDR, persists Quote.fiatCurrency, and echoes it back', async () => {
    const prisma = makePrisma();
    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) };
    const svc = makeSvc(prisma, adapter);

    const q = await svc.createQuote('GUSER', 'TOP_UP', 'BANK', { usdcAmount: 1_000_000_000n });

    expect(prisma.quote.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fiatCurrency: 'IDR' }) }),
    );
    expect(q.fiatCurrency).toBe('IDR');
  });

  it('persists and echoes an explicitly requested corridor', async () => {
    const prisma = makePrisma({
      market: {
        findMany: jest.fn().mockResolvedValue([
          makeMarketRow({ code: 'VND', priceMinPerUsdc: '15000', priceMaxPerUsdc: '40000' }),
        ]),
      },
      quote: {
        create: jest.fn().mockResolvedValue({ id: 'q2', fiatAmount: 1_600_000n, fiatCurrency: 'VND' }),
      },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ VND: '20000' }) };
    const svc = makeSvc(prisma, adapter);

    const q = await svc.createQuote(
      'GUSER',
      'TOP_UP',
      'BANK',
      { usdcAmount: 1_000_000_000n },
      'VND',
    );

    expect(prisma.quote.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fiatCurrency: 'VND' }) }),
    );
    expect(q.fiatCurrency).toBe('VND');
    expect(adapter.fetchPrices).toHaveBeenCalledWith(['VND']);
  });

  it('sets expiresAt to QUOTE_TTL_MS (300s) from now — price held 5 min per spec §7', async () => {
    const prisma = makePrisma();
    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) };
    const svc = makeSvc(prisma, adapter);

    expect(QUOTE_TTL_MS).toBe(300_000);

    const before = Date.now();
    await svc.createQuote('GUSER', 'TOP_UP', 'BANK', { usdcAmount: 1_000_000_000n });
    const after = Date.now();

    const call = prisma.quote.create.mock.calls[0][0];
    const expiresAtMs = call.data.expiresAt.getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + QUOTE_TTL_MS);
    expect(expiresAtMs).toBeLessThanOrEqual(after + QUOTE_TTL_MS);
  });

  it('rejects a disabled/unknown fiat with BadRequestException before creating a quote', async () => {
    const prisma = makePrisma({
      market: { findMany: jest.fn().mockResolvedValue([makeMarketRow({ code: 'PHP', enabled: false })]) },
    });
    const adapter = { name: 'mock', fetchPrices: jest.fn() };
    const svc = makeSvc(prisma, adapter);

    await expect(
      svc.createQuote('GUSER', 'TOP_UP', 'BANK', { usdcAmount: 1_000_000_000n }, 'PHP'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.quote.create).not.toHaveBeenCalled();
    expect(adapter.fetchPrices).not.toHaveBeenCalled();
  });
});

describe('RateService.createQuote — per-tier daily limit (Phase 6 Task 3)', () => {
  const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) };

  it('allows a quote when used24h + this quote is UNDER the tier limit', async () => {
    const prisma = makePrisma();
    const userReputation = makeReputationStub({
      personIdFor: jest.fn().mockResolvedValue('person-test'),
      getReputation: jest.fn().mockResolvedValue({ tier: 'SILVER', completedTrades: 10, disputesLost: 0, completionRate: 1 }),
      dailyLimitBaseUnits: jest.fn().mockReturnValue(3_000_000_000n),
      used24hBaseUnits: jest.fn().mockResolvedValue(1_000_000_000n),
    });
    const svc = makeSvc(prisma, adapter, mockCfg, userReputation);

    const q = await svc.createQuote('GUSER', 'TOP_UP', 'BANK', { usdcAmount: 1_000_000_000n });
    expect(q).toBeDefined();
    expect(prisma.quote.create).toHaveBeenCalled();
  });

  it('allows a quote when used24h + this quote EXACTLY EQUALS the limit (inclusive boundary — only `>` rejects)', async () => {
    const prisma = makePrisma();
    const userReputation = makeReputationStub({
      dailyLimitBaseUnits: jest.fn().mockReturnValue(1_000_000_000n),
      used24hBaseUnits: jest.fn().mockResolvedValue(0n),
    });
    const svc = makeSvc(prisma, adapter, mockCfg, userReputation);

    await svc.createQuote('GUSER', 'TOP_UP', 'BANK', { usdcAmount: 1_000_000_000n });
    expect(prisma.quote.create).toHaveBeenCalled();
  });

  it('rejects a quote that pushes used24h + this quote OVER the tier limit — 400 daily limit exceeded', async () => {
    const prisma = makePrisma();
    const userReputation = makeReputationStub({
      dailyLimitBaseUnits: jest.fn().mockReturnValue(1_000_000_000n),
      used24hBaseUnits: jest.fn().mockResolvedValue(500_000_000n),
    });
    const svc = makeSvc(prisma, adapter, mockCfg, userReputation);

    await expect(
      svc.createQuote('GUSER', 'TOP_UP', 'BANK', { usdcAmount: 600_000_000n }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      svc.createQuote('GUSER', 'TOP_UP', 'BANK', { usdcAmount: 600_000_000n }),
    ).rejects.toThrow('daily limit exceeded');
    expect(prisma.quote.create).not.toHaveBeenCalled();
  });

  it('different tiers get different limits — a higher tier allows an amount a lower tier would reject', async () => {
    const prisma = makePrisma();
    const userReputation = makeReputationStub({
      personIdFor: jest.fn().mockResolvedValue('person-test'),
      getReputation: jest.fn().mockResolvedValue({ tier: 'GOLD', completedTrades: 100, disputesLost: 0, completionRate: 1 }),

      dailyLimitBaseUnits: jest.fn((tier: string) => (tier === 'GOLD' ? 20_000_000_000n : 1_000_000_000n)),
      used24hBaseUnits: jest.fn().mockResolvedValue(0n),
    });
    const svc = makeSvc(prisma, adapter, mockCfg, userReputation);

    await svc.createQuote('GUSER', 'TOP_UP', 'BANK', { usdcAmount: 5_000_000_000n });
    expect(prisma.quote.create).toHaveBeenCalled();
    expect(userReputation.dailyLimitBaseUnits).toHaveBeenCalledWith('GOLD', expect.anything());
  });

  it('wires the resolved Config row into dailyLimitBaseUnits, honoring Config.dailyLimitByTier when present', async () => {
    const prisma = makePrisma({
      config: {
        upsert: jest.fn().mockResolvedValue({
          id: 1,
          spreadBps: 150,
          platformFeeBps: 30,
          lpFeeBps: 120,
          minOrder: 50_000_000n,
          maxOrder: 10_000_000_000n,
          paused: false,
          platformWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          dailyLimitByTier: { BRONZE: 5000 },
        }),
      },
    });
    const userReputation = makeReputationStub();
    const svc = makeSvc(prisma, adapter, mockCfg, userReputation);

    await svc.createQuote('GUSER', 'TOP_UP', 'BANK', { usdcAmount: 1_000_000_000n });
    expect(userReputation.dailyLimitBaseUnits).toHaveBeenCalledWith(
      'BRONZE',
      expect.objectContaining({ dailyLimitByTier: { BRONZE: 5000 } }),
    );
  });

  it('wires a null/absent Config.dailyLimitByTier through unchanged — defaults are UserReputationService\'s responsibility', async () => {
    const prisma = makePrisma();
    const userReputation = makeReputationStub();
    const svc = makeSvc(prisma, adapter, mockCfg, userReputation);

    await svc.createQuote('GUSER', 'TOP_UP', 'BANK', { usdcAmount: 1_000_000_000n });
    expect(userReputation.dailyLimitBaseUnits).toHaveBeenCalledWith(
      'BRONZE',
      expect.not.objectContaining({ dailyLimitByTier: expect.anything() }),
    );
  });

  it('fails CLOSED when getReputation throws — propagates (500), never silently allows the quote', async () => {
    const prisma = makePrisma();
    const userReputation = makeReputationStub({
      personIdFor: jest.fn().mockResolvedValue('person-test'),
      getReputation: jest.fn().mockRejectedValue(new Error('db unavailable')),
    });
    const svc = makeSvc(prisma, adapter, mockCfg, userReputation);

    await expect(
      svc.createQuote('GUSER', 'TOP_UP', 'BANK', { usdcAmount: 1_000_000_000n }),
    ).rejects.toThrow('db unavailable');
    expect(prisma.quote.create).not.toHaveBeenCalled();
  });

  it('fails CLOSED when used24hBaseUnits throws — propagates (500), never silently allows the quote', async () => {
    const prisma = makePrisma();
    const userReputation = makeReputationStub({
      used24hBaseUnits: jest.fn().mockRejectedValue(new Error('db unavailable')),
    });
    const svc = makeSvc(prisma, adapter, mockCfg, userReputation);

    await expect(
      svc.createQuote('GUSER', 'TOP_UP', 'BANK', { usdcAmount: 1_000_000_000n }),
    ).rejects.toThrow('db unavailable');
    expect(prisma.quote.create).not.toHaveBeenCalled();
  });
});
