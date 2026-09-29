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

  function jsonResponse(
    body: unknown,
    ok = true,
    status = 200,
    headers: Record<string, string> = {},
  ) {
    return {
      ok,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response;
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
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=idr,php',
    );
    expect(init?.redirect).toBe('error');
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

  it('rejects a rate that is not literally a JSON number, even when it would coerce to a plausible one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ 'usd-coin': { idr: ['17979.22'], php: 58.4 } }));

    const result = await adapter.fetchPrices(['IDR', 'PHP']);

    expect(result).toEqual({ PHP: '58.4' });
  });

  it('omits a fiat whose rate parses to a non-finite number (a JSON number can still overflow)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{"usd-coin":{"idr":1e999,"php":58.4}}',
    } as unknown as Response);

    const result = await adapter.fetchPrices(['IDR', 'PHP']);

    expect(result).toEqual({ PHP: '58.4' });
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

  it('never embeds a URL fragment in the fetch-error message (the throw site that will carry a future API key)', async () => {
    const err = new Error('boom');
    (err as any).cause = new Error('connect ECONNREFUSED 104.18.0.1:443');
    fetchMock.mockRejectedValue(err);

    const message = await adapter.fetchPrices(['IDR']).catch((e: Error) => e.message);

    expect(message).not.toMatch(/http/i);
  });

  it('does not clear the abort timer until the body has been read (regression: the body read was unbounded)', async () => {
    let resolveText!: (v: string) => void;
    const textPromise = new Promise<string>((res) => {
      resolveText = res;
    });
    const clearSpy = jest.spyOn(global, 'clearTimeout');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => textPromise,
    } as unknown as Response);

    const promise = adapter.fetchPrices(['IDR']);
    await new Promise((r) => setImmediate(r));

    expect(clearSpy).not.toHaveBeenCalled();

    resolveText(JSON.stringify({ 'usd-coin': { idr: 16000 } }));
    await promise;

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('caps a malformed-JSON body to 10 chars and escapes control characters before it reaches the thrown message', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'X\nFORGED_LEAK_DATA_THAT_SHOULD_NEVER_APPEAR',
    } as unknown as Response);

    const err = await adapter.fetchPrices(['IDR']).catch((e: Error) => e);

    expect((err as Error).message).not.toContain('FORGED_LEAK_DATA_THAT_SHOULD_NEVER_APPEAR');
    expect((err as Error).message).not.toMatch(/[\r\n]/);
  });

  it('includes Retry-After in the thrown message when the response carries the header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 429, { 'retry-after': '29' }));

    await expect(adapter.fetchPrices(['IDR'])).rejects.toThrow('coingecko 429 (retry-after: 29)');
  });

  it('sanitizes a hostile Retry-After header before it reaches the thrown message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({}, false, 429, { 'retry-after': '29\x1b[2Jx'.repeat(50) }),
    );

    const message = await adapter.fetchPrices(['IDR']).catch((e: Error) => e.message);

    expect(message).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(message.length).toBeLessThanOrEqual('coingecko 429 (retry-after: )'.length + 200);
  });

  it('keeps the refusal status code when the body read itself stalls and aborts', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: () =>
        new Promise((_resolve, reject) => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        }),
    } as unknown as Response);

    await expect(adapter.fetchPrices(['IDR'])).rejects.toThrow('coingecko 403 fetch error');
  });

  it('sanitizes a hostile fetch-rejection message before it reaches the thrown message', async () => {
    fetchMock.mockRejectedValue(new Error('boom\x1b[2Jforged'.repeat(50)));

    const message = await adapter.fetchPrices(['IDR']).catch((e: Error) => e.message);

    expect(message).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('sanitizes a hostile e.cause before it reaches the thrown message', async () => {
    const err = new Error('terminated');
    (err as any).cause = new Error('boom\x1b[2Jforged'.repeat(50));
    fetchMock.mockRejectedValue(err);

    const message = await adapter.fetchPrices(['IDR']).catch((e: Error) => e.message);

    expect(message).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('omits the retry-after suffix when the response carries no such header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 403));

    const message = await adapter.fetchPrices(['IDR']).catch((e: Error) => e.message);

    expect(message).toBe('coingecko 403');
  });

  it('includes a bounded e.cause in the thrown fetch-error message when present', async () => {
    const err = new Error('terminated');
    (err as any).cause = new Error('Body Timeout Error');
    fetchMock.mockRejectedValue(err);

    await expect(adapter.fetchPrices(['IDR'])).rejects.toThrow(
      'coingecko fetch error: terminated (cause: Body Timeout Error)',
    );
  });

  it('caps e.cause at exactly 120 characters, not merely somewhere beyond it', async () => {
    const err = new Error('terminated');
    (err as any).cause = new Error('Z'.repeat(500));
    fetchMock.mockRejectedValue(err);

    const message = await adapter.fetchPrices(['IDR']).catch((e: Error) => e.message);

    expect(message).toBe(`coingecko fetch error: terminated (cause: ${'Z'.repeat(120)})`);
  });
});
