import { ConfigCache, invalidateAllConfigCaches, CONFIG_TTL_MS } from './config-cache';

const WALLET = 'GBSYTTNQVWKH2DOIWXSE6UVJXRCUIXKSC5TBPYWNLCXLS35FKH7DNOHT';

function makePrisma(row: Record<string, unknown> = { id: 1, paused: false }) {
  const upsert = jest.fn(async (_args: any) => row);
  return { prisma: { config: { upsert } } as any, upsert };
}

describe('ConfigCache', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    invalidateAllConfigCaches();
  });
  afterEach(() => jest.useRealTimers());

  it('reads through to the database on the first call', async () => {
    const { prisma, upsert } = makePrisma();
    const row = await new ConfigCache().read(prisma, WALLET);

    expect(row).toEqual({ id: 1, paused: false });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('creates the row with the platform wallet it is handed', async () => {
    const { prisma, upsert } = makePrisma();
    await new ConfigCache().read(prisma, WALLET);

    expect(upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      update: {},
      create: { id: 1, platformWallet: WALLET },
    });
  });

  it('serves the cached row inside the TTL without touching the database again', async () => {
    const { prisma, upsert } = makePrisma();
    const cache = new ConfigCache();

    await cache.read(prisma, WALLET);
    jest.advanceTimersByTime(CONFIG_TTL_MS - 1);
    await cache.read(prisma, WALLET);

    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('reads again once the TTL has passed', async () => {
    const { prisma, upsert } = makePrisma();
    const cache = new ConfigCache();

    await cache.read(prisma, WALLET);
    jest.advanceTimersByTime(CONFIG_TTL_MS);
    await cache.read(prisma, WALLET);

    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('reads again immediately after it is invalidated', async () => {
    const { prisma, upsert } = makePrisma();
    const cache = new ConfigCache();

    await cache.read(prisma, WALLET);
    cache.invalidate();
    await cache.read(prisma, WALLET);

    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('invalidateAllConfigCaches clears every cache, not just the one that was written through', async () => {
    const a = makePrisma();
    const b = makePrisma();
    const cacheA = new ConfigCache();
    const cacheB = new ConfigCache();

    await cacheA.read(a.prisma, WALLET);
    await cacheB.read(b.prisma, WALLET);
    invalidateAllConfigCaches();
    await cacheA.read(a.prisma, WALLET);
    await cacheB.read(b.prisma, WALLET);

    expect(a.upsert).toHaveBeenCalledTimes(2);
    expect(b.upsert).toHaveBeenCalledTimes(2);
  });

  it('surfaces a paused flag written between two reads as soon as the cache is invalidated', async () => {
    let paused = false;
    const prisma = { config: { upsert: jest.fn(async () => ({ id: 1, paused })) } } as any;
    const cache = new ConfigCache();

    expect((await cache.read(prisma, WALLET)).paused).toBe(false);
    paused = true;
    expect((await cache.read(prisma, WALLET)).paused).toBe(false);

    invalidateAllConfigCaches();

    expect((await cache.read(prisma, WALLET)).paused).toBe(true);
  });
});
