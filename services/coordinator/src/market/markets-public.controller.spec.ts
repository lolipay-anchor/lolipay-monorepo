import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MarketsPublicController } from './markets-public.controller';
import { MarketsService } from './markets.service';

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

describe('GET /markets (public controller)', () => {
  let app: INestApplication;

  const mockMarketsService = {
    list: jest.fn(),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [MarketsPublicController],
      providers: [{ provide: MarketsService, useValue: mockMarketsService }],
    }).compile();

    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('returns an array of all markets, including disabled ones', async () => {
    mockMarketsService.list.mockResolvedValue([
      makeMarketRow({ code: 'IDR', enabled: true }),
      makeMarketRow({ code: 'PHP', country: 'Philippines', enabled: false }),
    ]);

    const res = await request(app.getHttpServer()).get('/markets').expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    const codes = res.body.map((m: any) => m.code);
    expect(codes).toEqual(['IDR', 'PHP']);
    const disabled = res.body.find((m: any) => m.code === 'PHP');
    expect(disabled.enabled).toBe(false);
  });

  it('each item has exactly the public snake_case shape', async () => {
    mockMarketsService.list.mockResolvedValue([makeMarketRow()]);

    const res = await request(app.getHttpServer()).get('/markets').expect(200);
    const [item] = res.body;

    expect(item).toEqual({
      code: 'IDR',
      country: 'Indonesia',
      currency_symbol: 'Rp',
      locale: 'id-ID',
      rail_name: 'QRIS',
      enabled: true,
    });
  });

  it('never leaks internal fields (priceMin/Max, manualRateOverride, rateSource, decimals)', async () => {
    mockMarketsService.list.mockResolvedValue([
      makeMarketRow({
        priceMinPerUsdc: '5000',
        priceMaxPerUsdc: '50000',
        manualRateOverride: '16500',
        rateSource: 'coingecko',
        decimals: 0,
      }),
    ]);

    const res = await request(app.getHttpServer()).get('/markets').expect(200);
    const [item] = res.body;

    expect(item.priceMinPerUsdc).toBeUndefined();
    expect(item.priceMaxPerUsdc).toBeUndefined();
    expect(item.price_min_per_usdc).toBeUndefined();
    expect(item.price_max_per_usdc).toBeUndefined();
    expect(item.manualRateOverride).toBeUndefined();
    expect(item.manual_rate_override).toBeUndefined();
    expect(item.rateSource).toBeUndefined();
    expect(item.rate_source).toBeUndefined();
    expect(item.decimals).toBeUndefined();
    expect(item.updatedAt).toBeUndefined();
    expect(item.updated_at).toBeUndefined();
  });

  it('is served from MarketsService.list() (respects the 5s cache), not a raw prisma call', async () => {
    mockMarketsService.list.mockResolvedValue([makeMarketRow()]);
    await request(app.getHttpServer()).get('/markets').expect(200);
    expect(mockMarketsService.list).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array (not an error) if there are no markets', async () => {
    mockMarketsService.list.mockResolvedValue([]);
    const res = await request(app.getHttpServer()).get('/markets').expect(200);
    expect(res.body).toEqual([]);
  });
});

describe('MarketsPublicController throttle decorator', () => {
  it('GET /markets carries a @Throttle decorator matching the public /rate pattern (60s / 30 req)', () => {
    const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', MarketsPublicController.prototype.list);
    const limit = Reflect.getMetadata(
      'THROTTLER:LIMITdefault',
      MarketsPublicController.prototype.list,
    );
    expect(ttl).toBe(60_000);
    expect(limit).toBe(30);
  });
});
