import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { RatePublicController } from './rate-public.controller';
import { RateService } from './rate.service';
import { MarketsService } from '../market/markets.service';

describe('GET /rate (public controller)', () => {
  let app: INestApplication;

  const mockRateService = {
    getDisplayRate: jest.fn<Promise<string>, [string]>(),
  };
  const mockMarketsService = {
    get: jest.fn<Promise<any>, [string]>(),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [RatePublicController],
      providers: [
        { provide: RateService, useValue: mockRateService },
        { provide: MarketsService, useValue: mockMarketsService },
      ],
    }).compile();

    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => {
    jest.clearAllMocks();

    mockMarketsService.get.mockResolvedValue({ code: 'IDR', enabled: true });
  });

  it('returns {asset, fiat, rate, ts} for default IDR', async () => {
    mockRateService.getDisplayRate.mockResolvedValue('16240');
    const res = await request(app.getHttpServer()).get('/rate').expect(200);

    expect(res.body.asset).toBe('USDC');
    expect(res.body.fiat).toBe('IDR');
    expect(typeof res.body.rate).toBe('string');
    expect(Number.isFinite(parseFloat(res.body.rate))).toBe(true);
    expect(parseFloat(res.body.rate)).toBeGreaterThan(0);
    expect(typeof res.body.ts).toBe('string');

    expect(new Date(res.body.ts).toISOString()).toBe(res.body.ts);
  });

  it('GET /rate?fiat=IDR works explicitly', async () => {
    mockRateService.getDisplayRate.mockResolvedValue('16240');
    const res = await request(app.getHttpServer()).get('/rate?fiat=IDR').expect(200);
    expect(res.body.fiat).toBe('IDR');
    expect(mockMarketsService.get).toHaveBeenCalledWith('IDR');
    expect(mockRateService.getDisplayRate).toHaveBeenCalledWith('IDR');
  });

  it('GET /rate?fiat=idr is normalized to IDR', async () => {
    mockRateService.getDisplayRate.mockResolvedValue('16240');
    const res = await request(app.getHttpServer()).get('/rate?fiat=idr').expect(200);
    expect(res.body.fiat).toBe('IDR');
    expect(mockMarketsService.get).toHaveBeenCalledWith('IDR');
    expect(mockRateService.getDisplayRate).toHaveBeenCalledWith('IDR');
  });

  it('GET /rate?fiat=US → 400 malformed, neither markets nor rate service called', async () => {
    const res = await request(app.getHttpServer()).get('/rate?fiat=US').expect(400);
    expect(res.body.message).toMatch(/invalid fiat/i);
    expect(mockMarketsService.get).not.toHaveBeenCalled();
    expect(mockRateService.getDisplayRate).not.toHaveBeenCalled();
  });

  it('GET /rate?fiat=ZZZ → 400 unsupported (unknown corridor, no Market row)', async () => {
    mockMarketsService.get.mockResolvedValue(null);
    const res = await request(app.getHttpServer()).get('/rate?fiat=ZZZ').expect(400);
    expect(res.body.message).toMatch(/unsupported/i);
    expect(mockMarketsService.get).toHaveBeenCalledWith('ZZZ');
    expect(mockRateService.getDisplayRate).not.toHaveBeenCalled();
  });

  it('GET /rate?fiat=JPY → 400 unsupported (unknown corridor)', async () => {
    mockMarketsService.get.mockResolvedValue(null);
    await request(app.getHttpServer()).get('/rate?fiat=JPY').expect(400);
  });

  it('GET /rate?fiat=PHP → 400 "fiat not enabled" (known but disabled corridor)', async () => {
    mockMarketsService.get.mockResolvedValue({ code: 'PHP', enabled: false });
    const res = await request(app.getHttpServer()).get('/rate?fiat=PHP').expect(400);
    expect(res.body.message).toBe('fiat not enabled');
    expect(mockMarketsService.get).toHaveBeenCalledWith('PHP');
    expect(mockRateService.getDisplayRate).not.toHaveBeenCalled();
  });

  it('rate is spread-applied (16240 > mid 16000)', async () => {
    mockRateService.getDisplayRate.mockResolvedValue('16240');
    const res = await request(app.getHttpServer()).get('/rate').expect(200);
    expect(res.body.rate).toBe('16240');

    expect(parseFloat(res.body.rate)).toBeGreaterThan(16000);
  });

  it('service 503 propagates', async () => {
    mockRateService.getDisplayRate.mockRejectedValue(
      new ServiceUnavailableException('price source unavailable'),
    );
    await request(app.getHttpServer()).get('/rate').expect(503);
  });

  it('paused platform 503 propagates', async () => {
    mockRateService.getDisplayRate.mockRejectedValue(
      new ServiceUnavailableException('paused'),
    );
    await request(app.getHttpServer()).get('/rate').expect(503);
  });

  it('response does not expose mid price or spread separately', async () => {
    mockRateService.getDisplayRate.mockResolvedValue('16240');
    const res = await request(app.getHttpServer()).get('/rate').expect(200);
    expect(res.body.mid).toBeUndefined();
    expect(res.body.spread).toBeUndefined();
    expect(res.body.spread_bps).toBeUndefined();
  });
});

describe('RateService.getDisplayRate', () => {
  const mockCfg = {
    priceStaleSecs: 120,
    priceDeviationMaxBps: 500,
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

  function makePrisma(configOverride: Record<string, any> = {}, marketRows = [makeMarketRow()]) {
    return {
      fiatPriceCache: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
      market: {
        findMany: jest.fn().mockResolvedValue(marketRows),
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
          platformWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          ...configOverride,
        }),
      },
      quote: { create: jest.fn() },
    } as any;
  }

  function makeSvc(prisma: any, adapter: any) {
    const markets = new MarketsService(prisma);

    const userReputation = {
      getReputation: jest.fn(),
      dailyLimitBaseUnits: jest.fn(),
      used24hBaseUnits: jest.fn(),
    } as any;
    return new RateService(prisma, mockCfg, adapter, markets, userReputation);
  }

  it('returns spread-applied rate > mid price (IDR, 150bps spread on 16000)', async () => {
    const prisma = makePrisma();
    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) };
    const svc = makeSvc(prisma, adapter);

    const rate = await svc.getDisplayRate('IDR');

    expect(rate).toBe('16240');
    expect(parseFloat(rate)).toBeGreaterThan(16000);
  });

  it('returns spread-applied rate for zero-spread (rate equals mid)', async () => {
    const prisma = makePrisma({ spreadBps: 0 });
    const adapter = { name: 'mock', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) };
    const svc = makeSvc(prisma, adapter);

    const rate = await svc.getDisplayRate('IDR');
    expect(rate).toBe('16000');
  });

  it('throws 503 when platform is paused', async () => {
    const prisma = makePrisma({ paused: true });
    const adapter = { name: 'mock', fetchPrices: jest.fn() };
    const svc = makeSvc(prisma, adapter);

    await expect(svc.getDisplayRate('IDR')).rejects.toThrow(ServiceUnavailableException);
    await expect(svc.getDisplayRate('IDR')).rejects.toThrow('paused');
    expect(adapter.fetchPrices).not.toHaveBeenCalled();
  });

  it('propagates 503 from getReferencePrice when adapter fails and cache stale', async () => {
    const staleFetchedAt = new Date(Date.now() - 200_000);
    const prisma = makePrisma();
    prisma.fiatPriceCache.findUnique = jest.fn().mockResolvedValue({
      fiat: 'IDR',
      source: 'coingecko',
      pricePerUsdc: '16000',
      fetchedAt: staleFetchedAt,
    });
    const adapter = {
      name: 'mock',
      fetchPrices: jest.fn().mockRejectedValue(new Error('network error')),
    };
    const svc = makeSvc(prisma, adapter);

    await expect(svc.getDisplayRate('IDR')).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('applySpreadToRate (money.ts)', () => {
  it('applies 150bps spread to 16000 → 16240', async () => {
    const { applySpreadToRate } = await import('../money/money');
    expect(applySpreadToRate('16000', 150)).toBe('16240');
  });

  it('applies 0bps spread → same value', async () => {
    const { applySpreadToRate } = await import('../money/money');
    expect(applySpreadToRate('16000', 0)).toBe('16000');
  });

  it('handles decimal mid price (500bps spread on 16000.5)', async () => {
    const { applySpreadToRate } = await import('../money/money');

    const result = applySpreadToRate('16000.5', 500);
    expect(parseFloat(result)).toBeCloseTo(16800.525, 2);
  });

  it('throws RangeError on invalid price', async () => {
    const { applySpreadToRate } = await import('../money/money');
    expect(() => applySpreadToRate('not-a-number', 0)).toThrow(RangeError);
    expect(() => applySpreadToRate('-100', 0)).toThrow(RangeError);
  });
});
