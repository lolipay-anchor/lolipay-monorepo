import { CoinGeckoAdapter } from './coingecko.adapter';

describe('CoinGeckoAdapter.fetchPrices', () => {
  let adapter: CoinGeckoAdapter;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    adapter = new CoinGeckoAdapter();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function jsonResponse(body: unknown, ok = true, status = 200) {
    return {
      ok,
      status,
      json: async () => body,
    } as Response;
  }

  it('parses a multi-fiat response into an uppercase-keyed record of decimal strings', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ 'usd-coin': { idr: 16234.5, php: 58.4 } }),
    );

    const result = await adapter.fetchPrices(['IDR', 'PHP']);

    expect(result).toEqual({ IDR: '16234.5', PHP: '58.4' });
  });

  it('calls CoinGecko with a single lowercase, comma-joined vs_currencies param', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ 'usd-coin': { idr: 16000, php: 58 } }));

    await adapter.fetchPrices(['IDR', 'PHP']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=idr,php',
    );
  });

  it('stringifies a whole-number price without a trailing decimal (matches prior single-fiat behavior)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ 'usd-coin': { idr: 16000 } }));

    const result = await adapter.fetchPrices(['IDR']);

    expect(result).toEqual({ IDR: '16000' });
  });

  it('omits a fiat missing from the response instead of failing the whole call', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ 'usd-coin': { idr: 16234.5 } }));

    const result = await adapter.fetchPrices(['IDR', 'PHP']);

    expect(result).toEqual({ IDR: '16234.5' });
    expect(result.PHP).toBeUndefined();
  });

  it('omits a fiat with a non-positive price instead of failing the whole call', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ 'usd-coin': { idr: 16234.5, php: 0, vnd: -5 } }),
    );

    const result = await adapter.fetchPrices(['IDR', 'PHP', 'VND']);

    expect(result).toEqual({ IDR: '16234.5' });
  });

  it('returns an empty record when the whole "usd-coin" key is missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    const result = await adapter.fetchPrices(['IDR', 'PHP']);

    expect(result).toEqual({});
  });

  it('throws when the upstream response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 503));

    await expect(adapter.fetchPrices(['IDR'])).rejects.toThrow('coingecko 503');
  });

  it('throws a wrapped error when fetch itself rejects', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));

    await expect(adapter.fetchPrices(['IDR'])).rejects.toThrow('coingecko fetch error: boom');
  });

  it('aborts the request via AbortController when the timeout elapses', async () => {
    jest.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const promise = adapter.fetchPrices(['IDR']);
    const assertion = expect(promise).rejects.toThrow('coingecko fetch error');
    jest.advanceTimersByTime(5_000);
    await assertion;
    expect(capturedSignal?.aborted).toBe(true);

    jest.useRealTimers();
  });
});
