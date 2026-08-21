import { Account, Address, StrKey } from '@stellar/stellar-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { StellarReadService, withRpcRetry, isRetryableRpcError } from './stellar-read.service';

const FAKE_LP = 'GBEIUZUZ625KNMPNMKX7HSF2GPXZRD6CL7OUH7JD5CQQXNTTKLZNMSIA';

function makeSvc() {
  return new StellarReadService({
    rpcUrl: 'x',
    networkPassphrase: 'x',
    stakingContractId: 'C',
    escrowContractId: 'C',
  } as any);
}

const FAKE_CONTRACT_ID = 'CFAKEESCROW';

describe('StellarReadService (unit, fake simulate)', () => {
  it('isEligible decodes a boolean scVal — true', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => true;
    expect(await svc.isEligible(FAKE_LP)).toBe(true);
  });

  it('isEligible decodes a boolean scVal — false', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => false;
    expect(await svc.isEligible(FAKE_LP)).toBe(false);
  });

  it('getTradeStatus maps status index 0 to FUNDED', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => ({ status: 0 });
    expect(await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).toEqual({ status: 'FUNDED', settledAt: 0 });
  });

  it('getTradeStatus maps status index 1 to FIAT_PAID', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => ({ status: 1 });
    expect(await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).toEqual({ status: 'FIAT_PAID', settledAt: 0 });
  });

  it('getTradeStatus maps status index 2 to RELEASED', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => ({ status: 2 });
    expect(await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).toEqual({ status: 'RELEASED', settledAt: 0 });
  });

  it('getTradeStatus maps status index 3 to REFUNDED', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => ({ status: 3 });
    expect(await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).toEqual({ status: 'REFUNDED', settledAt: 0 });
  });

  it('getTradeStatus maps status index 4 to DISPUTED', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => ({ status: 4 });
    expect(await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).toEqual({ status: 'DISPUTED', settledAt: 0 });
  });

  it('getTradeStatus decodes settled_at (u64 unix-seconds) when present', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => ({ status: 2, settled_at: 1_700_000_000 });
    expect(await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).toEqual({
      status: 'RELEASED',
      settledAt: 1_700_000_000,
    });
  });

  it('getTradeStatus decodes a bigint settled_at (scValToNative u64 shape)', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => ({ status: 2, settled_at: 1_700_000_000n });
    expect(await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).toEqual({
      status: 'RELEASED',
      settledAt: 1_700_000_000,
    });
  });

  it('getTradeStatus falls back to settledAt 0 when settled_at is absent (older contract shape)', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => ({ status: 0 });
    expect(await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).toEqual({ status: 'FUNDED', settledAt: 0 });
  });

  it('getTradeStatus returns null when status is undefined (NaN guard)', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => ({ status: undefined });
    expect(await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).toBeNull();
  });

  it('getTradeStatus returns null when status is out of range', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => ({ status: 99 });
    expect(await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).toBeNull();
  });

  it('getTradeStatus returns null when simulateCall throws', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => { throw new Error('not found'); };
    expect(await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).toBeNull();
  });

  it('getTradeStatus returns null when simulateCall returns null', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => null;
    expect(await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).toBeNull();
  });

  it('getTradeStatus passes the EXPLICIT contractId to simulateCall, not cfg.escrowContractId', async () => {
    const svc = makeSvc();
    let seenContractId: string | undefined;
    (svc as any).simulateCall = async (contractId: string) => {
      seenContractId = contractId;
      return { status: 0 };
    };
    await svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd');
    expect(seenContractId).toBe(FAKE_CONTRACT_ID);
    expect(seenContractId).not.toBe('C');
  });

  it('getTradeStatusStrict passes the EXPLICIT contractId to simulateCall', async () => {
    const svc = makeSvc();
    let seenContractId: string | undefined;
    (svc as any).simulateCall = async (contractId: string) => {
      seenContractId = contractId;
      return { status: 2 };
    };
    const result = await svc.getTradeStatusStrict(FAKE_CONTRACT_ID, 'aabbccdd');
    expect(seenContractId).toBe(FAKE_CONTRACT_ID);
    expect(result).toEqual({ status: 'RELEASED', settledAt: 0 });
  });
});

describe('StellarReadService — escrow TradeNotFound (#5) recognized as not-found', () => {
  const ESCROW_NOT_FOUND_ERR = new Error(
    'HostError: Error(Contract, #5)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:CESCROW, ...',
  );

  it('getTradeStatusStrict returns null (does NOT throw) when simulateCall throws the escrow TradeNotFound (#5) error', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => {
      throw ESCROW_NOT_FOUND_ERR;
    };
    await expect(svc.getTradeStatusStrict(FAKE_CONTRACT_ID, 'aabbccdd')).resolves.toBeNull();
  });

  it('getTradeStatus (lenient) also returns null for the same #5 error (already lenient, no regression)', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => {
      throw ESCROW_NOT_FOUND_ERR;
    };
    await expect(svc.getTradeStatus(FAKE_CONTRACT_ID, 'aabbccdd')).resolves.toBeNull();
  });

  it('getTradeStatusStrict STILL throws (propagates) a genuine RPC/network error — #5 handling did not broaden generic error handling', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => {
      throw new Error('simulateTransaction timed out after 5000ms');
    };
    await expect(svc.getTradeStatusStrict(FAKE_CONTRACT_ID, 'aabbccdd')).rejects.toThrow(/timed out/);
  });

  it('getTradeStatusStrict STILL throws (propagates) a DIFFERENT contract error code (e.g. #9 InvalidState) — only #5 is treated as not-found', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => {
      throw new Error('HostError: Error(Contract, #9)\n\nEvent log...');
    };
    await expect(svc.getTradeStatusStrict(FAKE_CONTRACT_ID, 'aabbccdd')).rejects.toThrow(/#9/);
  });

  it('getTradeStatusStrict still decodes a REAL trade correctly (successful get_trade is unaffected by the #5 matcher)', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = async () => ({ status: 0 });
    await expect(svc.getTradeStatusStrict(FAKE_CONTRACT_ID, 'aabbccdd')).resolves.toEqual({
      status: 'FUNDED',
      settledAt: 0,
    });
  });

  it('isRetryableRpcError(#5 error) === false — a genuine TradeNotFound must never be retried', () => {
    expect(isRetryableRpcError(ESCROW_NOT_FOUND_ERR)).toBe(false);
  });
});

describe('StellarReadService.getAccountFirstTxAt', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('returns the created_at of the first (oldest) transaction', async () => {
    const svc = makeSvc();
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        _embedded: { records: [{ created_at: '2020-01-01T00:00:00Z' }] },
      }),
    });
    global.fetch = fetchMock as any;

    const result = await svc.getAccountFirstTxAt(FAKE_LP);

    expect(result).toBe('2020-01-01T00:00:00Z');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/accounts/${FAKE_LP}/transactions?order=asc&limit=1&include_failed=false`),
    );
  });

  it('returns null (unknown) on a 404 (unfunded account) — never fabricates an age', async () => {
    const svc = makeSvc();
    global.fetch = jest.fn().mockResolvedValue({ status: 404, ok: false }) as any;

    expect(await svc.getAccountFirstTxAt(FAKE_LP)).toBeNull();
  });

  it('returns null when the account is funded but has zero transactions (empty records)', async () => {
    const svc = makeSvc();
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ _embedded: { records: [] } }),
    }) as any;

    expect(await svc.getAccountFirstTxAt(FAKE_LP)).toBeNull();
  });

  it('fails OPEN (returns null, never throws) on a network/timeout error', async () => {
    const svc = makeSvc();
    global.fetch = jest.fn().mockRejectedValue(new Error('timeout')) as any;

    await expect(svc.getAccountFirstTxAt(FAKE_LP)).resolves.toBeNull();
  });

  it('fails OPEN on a transient non-2xx (e.g. 500) without caching it', async () => {
    const svc = makeSvc();
    const fetchMock = jest.fn().mockResolvedValue({ status: 500, ok: false });
    global.fetch = fetchMock as any;

    expect(await svc.getAccountFirstTxAt(FAKE_LP)).toBeNull();
    expect(await svc.getAccountFirstTxAt(FAKE_LP)).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches a definitive result (5-min TTL) — second call within the window skips fetch', async () => {
    const svc = makeSvc();
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ _embedded: { records: [{ created_at: '2020-01-01T00:00:00Z' }] } }),
    });
    global.fetch = fetchMock as any;

    await svc.getAccountFirstTxAt(FAKE_LP);
    await svc.getAccountFirstTxAt(FAKE_LP);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('StellarReadService.buildRefundTx', () => {
  const FAKE_TRADE_ID = 'a'.repeat(64);
  const SIGNER_ADDR = FAKE_LP;

  const EXPLICIT_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 1));
  const CFG_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 2));

  function makeSvc() {
    return new StellarReadService({
      rpcUrl: 'x',
      networkPassphrase: 'Test SDF Network ; September 2015',
      stakingContractId: 'C',
      escrowContractId: CFG_CONTRACT,
    } as any);
  }

  const fakeAccount = new Account(SIGNER_ADDR, '100');

  it('returns the prepared Transaction OBJECT (not just xdr) — RefundSignerService.submitRefund needs to .sign() it', async () => {
    const svc = makeSvc();
    const preparedTxSentinel = { toXDR: () => 'prepared-xdr-sentinel' };
    const mockServer = {
      getAccount: jest.fn().mockResolvedValue(fakeAccount),
      prepareTransaction: jest.fn().mockResolvedValue(preparedTxSentinel),
    };
    (svc as any).createRpcServer = () => mockServer;

    const result = await svc.buildRefundTx(EXPLICIT_CONTRACT, FAKE_TRADE_ID, SIGNER_ADDR);

    expect(mockServer.getAccount).toHaveBeenCalledWith(SIGNER_ADDR);
    expect(mockServer.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(result).toBe(preparedTxSentinel);
  });

  it('invokes refund(trade_id) against the EXPLICIT contractId param, not cfg.escrowContractId', async () => {
    const svc = makeSvc();
    let seenOp: any;
    const mockServer = {
      getAccount: jest.fn().mockResolvedValue(fakeAccount),
      prepareTransaction: jest.fn(async (tx: any) => {
        seenOp = tx.operations[0];
        return tx;
      }),
    };
    (svc as any).createRpcServer = () => mockServer;

    await svc.buildRefundTx(EXPLICIT_CONTRACT, FAKE_TRADE_ID, SIGNER_ADDR);

    expect(seenOp.type).toBe('invokeHostFunction');
    const invokeArgs = seenOp.func.invokeContract();
    expect(invokeArgs.functionName().toString()).toBe('refund');
    expect(Address.fromScAddress(invokeArgs.contractAddress()).toString()).toBe(EXPLICIT_CONTRACT);
    expect(Address.fromScAddress(invokeArgs.contractAddress()).toString()).not.toBe(CFG_CONTRACT);

    expect(invokeArgs.args()).toHaveLength(1);
  });

  it('throws a clear error when the source account cannot be loaded', async () => {
    const svc = makeSvc();
    (svc as any).createRpcServer = () => ({
      getAccount: jest.fn().mockRejectedValue(new Error('account not found')),
      prepareTransaction: jest.fn(),
    });

    await expect(svc.buildRefundTx(EXPLICIT_CONTRACT, FAKE_TRADE_ID, SIGNER_ADDR)).rejects.toThrow(
      /could not load account/i,
    );
  });

  it('wraps a prepareTransaction failure with a descriptive error', async () => {
    const svc = makeSvc();
    (svc as any).createRpcServer = () => ({
      getAccount: jest.fn().mockResolvedValue(fakeAccount),
      prepareTransaction: jest.fn().mockRejectedValue(new Error('simulation failed')),
    });

    await expect(svc.buildRefundTx(EXPLICIT_CONTRACT, FAKE_TRADE_ID, SIGNER_ADDR)).rejects.toThrow(
      /prepareTransaction failed/i,
    );
  });
});

describe('withRpcRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('succeeds after 2 transient failures then success — thunk called 3x, resolves with the value', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('fetch failed: network timeout');
      return 'ok';
    });

    const promise = withRpcRetry(fn, 'testCall');
    await jest.runAllTimersAsync();

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('exhausts and throws the ORIGINAL error after `attempts` persistent transient failures', async () => {
    const persistent = new Error('503 Service Unavailable');
    const fn = jest.fn().mockRejectedValue(persistent);

    const promise = withRpcRetry(fn, 'testCall', { attempts: 3 });

    const assertion = expect(promise).rejects.toThrow('503 Service Unavailable');
    await jest.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects a custom `attempts` count (e.g. attempts:1 → no retry at all)', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const promise = withRpcRetry(fn, 'testCall', { attempts: 1 });
    const assertion = expect(promise).rejects.toThrow('ETIMEDOUT');
    await jest.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a not-found/isNotFound error — thunk called once, throws immediately', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('key not found'));
    await expect(withRpcRetry(fn, 'testCall')).rejects.toThrow('key not found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a MissingValue sentinel (isNotFound pattern) — thunk called once', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('HostError: Error(Storage, MissingValue)'));
    await expect(withRpcRetry(fn, 'testCall')).rejects.toThrow(/MissingValue/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-transient, non-not-found error either — only KNOWN transient patterns retry', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('invalid signature'));
    await expect(withRpcRetry(fn, 'testCall')).rejects.toThrow('invalid signature');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('each retry attempt is a FRESH call of the thunk (not a re-awaited settled promise)', async () => {
    const seen: number[] = [];
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      seen.push(calls);
      if (calls < 3) throw new Error('network error');
      return calls;
    });
    const promise = withRpcRetry(fn, 'testCall');
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe(3);

    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('isRetryableRpcError', () => {
  it.each([
    ['a withRpcTimeout timeout', 'testCall timed out after 5000ms'],
    ['a generic fetch failure', 'fetch failed'],
    ['ECONNRESET', 'read ECONNRESET'],
    ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:443'],
    ['HTTP 429', 'Request failed with status code 429'],
    ['HTTP 500', 'Internal Server Error (500)'],
    ['HTTP 502', 'Bad Gateway 502'],
    ['HTTP 503', 'upstream 503'],
    ['HTTP 504', 'Gateway Timeout 504'],
    ['getAccount load failure message', 'could not load source account for simulation'],
  ])('classifies %s as RETRYABLE', (_label, msg) => {
    expect(isRetryableRpcError(new Error(msg))).toBe(true);
  });

  it.each([
    ['a "not found" contract answer', 'not found'],
    ['a "key not found" contract answer', 'key not found'],
    ['a MissingValue sentinel', 'HostError: Error(Storage, MissingValue)'],
    ['an unrelated non-transient error', 'invalid signature'],
    ['a validation error', 'unknown flow "BOGUS"'],
  ])('classifies %s as NON-retryable', (_label, msg) => {
    expect(isRetryableRpcError(new Error(msg))).toBe(false);
  });
});

describe('submit path is NOT wrapped in retry', () => {
  it('refund-signer.service.ts: server.sendTransaction(tx) call site has no withRpcRetry wrapper', () => {
    const src = fs.readFileSync(
      path.join(__dirname, 'refund-signer.service.ts'),
      'utf8',
    );
    const sendLine = src.split('\n').find((l) => l.includes('server.sendTransaction(tx)'));
    expect(sendLine).toBeDefined();
    expect(sendLine).not.toContain('withRpcRetry');
    expect(sendLine).toContain('withRpcTimeout');
  });

  it('stellar-read.service.ts itself never CALLS server.sendTransaction (no submit path in this file)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'stellar-read.service.ts'), 'utf8');
    expect(src).not.toContain('server.sendTransaction');
  });
});

describe('hasUsdcTrustline cache', () => {
  function svcWithCfg() {
    return new StellarReadService({
      rpcUrl: 'x',
      networkPassphrase: 'x',
      stakingContractId: 'C',
      escrowContractId: 'C',
      horizonUrl: 'https://horizon.test',
      usdcAssetCode: 'USDC',
      usdcAssetIssuer: 'GISSUER',
    } as any);
  }
  const okResponse = (balances: unknown[]) =>
    ({ ok: true, status: 200, json: async () => ({ balances }) }) as any;

  afterEach(() => {
    (global.fetch as any) = undefined;
  });

  it('a false result is re-checked live on the next call (not cached) — newly added trustline is seen immediately', async () => {
    const svc = svcWithCfg();
    const fetchMock = jest
      .fn()

      .mockResolvedValueOnce(okResponse([{ asset_code: 'XLM' }]))

      .mockResolvedValueOnce(okResponse([{ asset_code: 'USDC', asset_issuer: 'GISSUER' }]));
    (global as any).fetch = fetchMock;

    expect(await svc.hasUsdcTrustline(FAKE_LP)).toBe(false);
    expect(await svc.hasUsdcTrustline(FAKE_LP)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('an unfunded account (404) is also not cached', async () => {
    const svc = svcWithCfg();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 } as any)
      .mockResolvedValueOnce(okResponse([{ asset_code: 'USDC', asset_issuer: 'GISSUER' }]));
    (global as any).fetch = fetchMock;

    expect(await svc.hasUsdcTrustline(FAKE_LP)).toBe(false);
    expect(await svc.hasUsdcTrustline(FAKE_LP)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a true result IS cached — the second call never hits Horizon', async () => {
    const svc = svcWithCfg();
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(okResponse([{ asset_code: 'USDC', asset_issuer: 'GISSUER' }]));
    (global as any).fetch = fetchMock;

    expect(await svc.hasUsdcTrustline(FAKE_LP)).toBe(true);
    expect(await svc.hasUsdcTrustline(FAKE_LP)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
