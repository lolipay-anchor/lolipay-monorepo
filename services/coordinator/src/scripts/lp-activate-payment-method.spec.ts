jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

import { execFileSync } from 'child_process';
import { Keypair } from '@stellar/stellar-sdk';
import { main } from './lp-activate-payment-method';

const API = 'http://coordinator.test';
const IDENTITY = 'e2e-provider';
const METHOD_ID = '35cec168-92d4-47cc-b745-0a4add0c6eed';
const NONCE = 'a-nonce-from-the-coordinator';
const JWT = 'the.session.jwt.the.coordinator.minted';

const execFileSyncMock = execFileSync as unknown as jest.Mock;
const provider = Keypair.random();
const realFetch = global.fetch;

function response(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

function stubFetch(patch: { status: number; body: string }): jest.Mock {
  const fetchMock = jest.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (target === `${API}/auth/challenge`) return response(200, JSON.stringify({ nonce: NONCE }));
    if (target === `${API}/auth/verify`) return response(200, JSON.stringify({ jwt: JWT }));
    if (target.startsWith(`${API}/lp/payment-methods/`)) return response(patch.status, patch.body);
    throw new Error(`the script asked for ${init?.method ?? 'GET'} ${target}, which this test does not stand in for`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function patchCallOf(fetchMock: jest.Mock): [string, RequestInit] {
  const call = fetchMock.mock.calls.find(([url]) => String(url).startsWith(`${API}/lp/payment-methods/`));
  if (!call) throw new Error('the script never asked for /lp/payment-methods/');
  return [String(call[0]), call[1] as RequestInit];
}

describe('lp-activate-payment-method asks the coordinator to flip one provider payment method active', () => {
  beforeEach(() => {
    process.env.SEP24_API = API;
    process.exitCode = 0;
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(`${provider.secret()}\n`);
  });

  afterEach(() => {
    process.exitCode = 0;
    global.fetch = realFetch;
    delete process.env.SEP24_API;
  });

  it('reads the named keystore identity and authenticates as it, never as some other key', async () => {
    const fetchMock = stubFetch({ status: 200, body: JSON.stringify({ id: METHOD_ID, active: true }) });

    await main([IDENTITY, METHOD_ID]);

    expect(execFileSyncMock).toHaveBeenCalledWith('stellar', ['keys', 'secret', IDENTITY], { encoding: 'utf8' });
    const challenge = fetchMock.mock.calls.find(([url]) => String(url) === `${API}/auth/challenge`);
    expect(JSON.parse(String((challenge?.[1] as RequestInit).body))).toEqual({ address: provider.publicKey() });
  });

  it('PATCHes exactly {"active":true} as JSON at the named method, bearing the session token it just minted', async () => {
    const fetchMock = stubFetch({ status: 200, body: JSON.stringify({ id: METHOD_ID, active: true }) });

    await main([IDENTITY, METHOD_ID]);

    const [url, init] = patchCallOf(fetchMock);
    expect(url).toBe(`${API}/lp/payment-methods/${METHOD_ID}`);
    expect(init.method).toBe('PATCH');
    expect(init.headers).toEqual({
      authorization: `Bearer ${JWT}`,
      'content-type': 'application/json',
    });
    expect(init.body).toBe('{"active":true}');
    expect(JSON.parse(String(init.body))).not.toHaveProperty('details');
    expect(process.exitCode).toBe(0);
  });

  it('exits non-zero when the coordinator refuses, instead of reporting success', async () => {
    stubFetch({ status: 403, body: JSON.stringify({ message: 'Forbidden resource' }) });

    await main([IDENTITY, METHOD_ID]);

    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero when a 200 hands back a row that is still inactive, so an ignored body cannot read as success', async () => {
    stubFetch({ status: 200, body: JSON.stringify({ id: METHOD_ID, active: false }) });

    await main([IDENTITY, METHOD_ID]);

    expect(process.exitCode).toBe(1);
  });

  it('refuses without an identity name and a method id, rather than asking the keystore for nothing', async () => {
    const fetchMock = stubFetch({ status: 200, body: '{}' });

    await expect(main([IDENTITY])).rejects.toThrow(/usage/i);

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
