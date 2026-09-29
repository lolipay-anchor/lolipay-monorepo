import { CoinbaseAdapter } from './coinbase.adapter';

describe('CoinbaseAdapter.fetchPrices', () => {
  let adapter: CoinbaseAdapter;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    adapter = new CoinbaseAdapter();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function jsonResponse(body: unknown, ok = true, status = 200, headers: Record<string, string> = {}) {
    return {
      ok,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
    } as unknown as Response;
  }

  const usdcBody = {
    data: {
      currency: 'USDC',
      rates: { IDR: '16234.5', PHP: '58.4' },
    },
  };

  it('parses a multi-fiat response into an uppercase-keyed record of 6-decimal strings', async () => {
    fetchMock.mockResolvedValue(jsonResponse(usdcBody));

    const result = await adapter.fetchPrices(['IDR', 'PHP']);

    expect(result).toEqual({ IDR: '16234.500000', PHP: '58.400000' });
  });

  it('calls Coinbase at the fixed exchange-rates URL regardless of the requested fiats', async () => {
    fetchMock.mockResolvedValue(jsonResponse(usdcBody));

    await adapter.fetchPrices(['IDR', 'PHP', 'VND']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.coinbase.com/v2/exchange-rates?currency=USDC');
    expect(init?.redirect).toBe('error');
  });

  it('matches fiat codes against Coinbase UPPERCASE rate keys, not lowercase', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { currency: 'USDC', rates: { IDR: '16234.5' } } }),
    );

    const result = await adapter.fetchPrices(['idr']);

    expect(result).toEqual({ IDR: '16234.500000' });
  });

  it('narrows a long-precision decimal string to 6 decimal places', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { currency: 'USDC', rates: { IDR: '17979.2219454948222269812606' } },
      }),
    );

    const result = await adapter.fetchPrices(['IDR']);

    expect(result).toEqual({ IDR: '17979.221945' });
  });

  it('omits a fiat missing from the response instead of failing the whole call', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { currency: 'USDC', rates: { IDR: '16234.5' } } }),
    );

    const result = await adapter.fetchPrices(['IDR', 'PHP']);

    expect(result).toEqual({ IDR: '16234.500000' });
    expect(result.PHP).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('omits a fiat with a non-positive or non-numeric rate instead of failing the whole call', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { currency: 'USDC', rates: { IDR: '16234.5', PHP: '0', VND: '-5', THB: 'nope' } },
      }),
    );

    const result = await adapter.fetchPrices(['IDR', 'PHP', 'VND', 'THB']);

    expect(result).toEqual({ IDR: '16234.500000' });
  });

  it('omits a fiat whose rate string parses to a non-finite number', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { currency: 'USDC', rates: { IDR: '9'.repeat(400) } } }),
    );

    const result = await adapter.fetchPrices(['IDR']);

    expect(result.IDR).toBeUndefined();
  });

  it('logs a malformed present rate instead of failing silently, so a format change is distinguishable from an outage', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { currency: 'USDC', rates: { IDR: '1e4' } } }),
    );

    const result = await adapter.fetchPrices(['IDR']);

    expect(result.IDR).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('IDR'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('1e4'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('string'));
    errorSpy.mockRestore();
  });

  it('rejects a non-decimal wire value even when Number() would coerce it to a plausible rate', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          currency: 'USDC',
          rates: { IDR: '0x4E20', PHP: '16234.5', VND: '0o47540', THB: '0b100111000100000' },
        },
      }),
    );

    const result = await adapter.fetchPrices(['IDR', 'PHP', 'VND', 'THB']);

    expect(result).toEqual({ PHP: '16234.500000' });
  });

  it('omits a fiat whose rate arrives as a JSON number rather than the documented decimal string (fail-closed, not accidental)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { currency: 'USDC', rates: { IDR: 16234.5 } } }),
    );

    const result = await adapter.fetchPrices(['IDR']);

    expect(result.IDR).toBeUndefined();
  });

  it('throws when the base currency is not USDC', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { currency: 'USD', rates: { IDR: '16234.5' } } }),
    );

    await expect(adapter.fetchPrices(['IDR'])).rejects.toThrow('coinbase base currency USD');
  });

  it('throws when the response has no rates object', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { currency: 'USDC' } }));

    await expect(adapter.fetchPrices(['IDR'])).rejects.toThrow('coinbase response missing rates');
  });

  it('throws a clean status error when the upstream response is not ok', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 503));

    await expect(adapter.fetchPrices(['IDR'])).rejects.toThrow('coinbase 503');
  });

  it('appends Retry-After to the status error when the response carries one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 429, { 'retry-after': '30' }));

    await expect(adapter.fetchPrices(['IDR'])).rejects.toThrow('coinbase 429 retry-after 30');
  });

  it('sanitizes a hostile Retry-After header before it reaches the thrown message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({}, false, 429, { 'retry-after': '30\x1b[2Jx'.repeat(50) }),
    );

    const message = await adapter.fetchPrices(['IDR']).catch((e: Error) => e.message);

    expect(message).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(message.length).toBeLessThanOrEqual('coinbase 429 retry-after '.length + 200);
  });

  it('throws a wrapped error when fetch itself rejects', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));

    await expect(adapter.fetchPrices(['IDR'])).rejects.toThrow('coinbase fetch error: boom');
  });

  it('wraps a malformed JSON body as a fetch error, capped and newline-stripped', async () => {
    const longBody = 'not json\nwith a newline'.repeat(20);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError(`Unexpected token in ${longBody}`);
      },
    } as unknown as Response);

    let error: Error | undefined;
    try {
      await adapter.fetchPrices(['IDR']);
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message.startsWith('coinbase fetch error:')).toBe(true);
    expect(error!.message).not.toMatch(/[\r\n]/);
    expect(error!.message.length).toBeLessThanOrEqual('coinbase fetch error: '.length + 200);
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
    const assertion = expect(promise).rejects.toThrow('coinbase fetch error');
    jest.advanceTimersByTime(5_000);
    await assertion;
    expect(capturedSignal?.aborted).toBe(true);

    jest.useRealTimers();
  });

  it('keeps the timeout armed through a slow body read, not just a slow header response', async () => {
    jest.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    let bodyAborted = false;
    const onAbort = () => {
      bodyAborted = true;
    };
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () =>
          new Promise((_resolve, reject) => {
            const fail = () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            };
            if (capturedSignal?.aborted) {
              onAbort();
              fail();
              return;
            }
            capturedSignal?.addEventListener('abort', () => {
              onAbort();
              fail();
            });
          }),
      } as unknown as Response);
    });

    const promise = adapter.fetchPrices(['IDR']);
    const assertion = expect(promise).rejects.toThrow('coinbase fetch error');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(5_000);
    await assertion;
    expect(bodyAborted).toBe(true);

    jest.useRealTimers();
  });
});
