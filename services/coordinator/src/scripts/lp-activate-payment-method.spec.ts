jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

import { execFileSync } from 'child_process';
import { Keypair } from '@stellar/stellar-sdk';
import { main } from './lp-activate-payment-method';

const API = 'https://api.lolipay.app';
const IDENTITY = 'e2e-provider';
const METHOD_ID = '35cec168-92d4-47cc-b745-0a4add0c6eed';
const JWT = 'the.session.jwt.the.coordinator.minted';
const DESTINATION = 'THE-BANK-ACCOUNT-A-DEPOSITOR-PAYS-INTO';

const execFileSyncMock = execFileSync as unknown as jest.Mock;
const provider = Keypair.random();
const realFetch = global.fetch;

const challengeFor = (address: string) => `lolipay-auth:${address}:5f4d3c2b1a:${Date.now() + 60_000}:themac`;

const activeRow = JSON.stringify({ id: METHOD_ID, label: 'BCA', active: true, details: DESTINATION });
const inactiveRow = JSON.stringify({ id: METHOD_ID, label: 'BCA', active: false, details: DESTINATION });

function response(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

function stubFetch(patch: { status: number; body: string }, challenge = challengeFor(provider.publicKey())): jest.Mock {
  const fetchMock = jest.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    const { pathname } = new URL(target);
    if (pathname === '/auth/challenge') return response(200, JSON.stringify({ nonce: challenge }));
    if (pathname === '/auth/verify') return response(200, JSON.stringify({ jwt: JWT }));
    if (pathname.startsWith('/lp/payment-methods/')) return response(patch.status, patch.body);
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

function printed(): string {
  const said = (spy: jest.SpyInstance) => spy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
  return `${said(logSpy)}\n${said(errorSpy)}`;
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

describe('lp-activate-payment-method asks the coordinator to flip one provider payment method active', () => {
  beforeEach(() => {
    process.exitCode = 0;
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(`${provider.secret()}\n`);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = 0;
    global.fetch = realFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    delete process.env.SEP24_API;
  });

  it('reads the named keystore identity and authenticates as it, never as some other key', async () => {
    const fetchMock = stubFetch({ status: 200, body: activeRow });

    await main([IDENTITY, METHOD_ID]);

    expect(execFileSyncMock).toHaveBeenCalledWith('stellar', ['keys', 'secret', IDENTITY], { encoding: 'utf8' });
    const challenge = fetchMock.mock.calls.find(([url]) => String(url) === `${API}/auth/challenge`);
    expect(JSON.parse(String((challenge?.[1] as RequestInit).body))).toEqual({ address: provider.publicKey() });
  });

  it('PATCHes exactly {"active":true} as JSON at the named method, bearing the session token it just minted', async () => {
    const fetchMock = stubFetch({ status: 200, body: activeRow });

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

  it('talks to the production coordinator even when the environment named another host before this module was loaded, so no variable can redirect the key that signs', async () => {
    process.env.SEP24_API = 'http://a-host-the-operator-did-not-choose.test';
    const fetchMock = stubFetch({ status: 200, body: activeRow });
    let loaded!: typeof import('./lp-activate-payment-method');
    jest.isolateModules(() => {
      loaded = require('./lp-activate-payment-method') as typeof import('./lp-activate-payment-method');
    });

    await loaded.main([IDENTITY, METHOD_ID]);

    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual([API, API, API]);
  });

  it('refuses a challenge that is not a lolipay challenge for its own key, and never posts a signature over it', async () => {
    const fetchMock = stubFetch({ status: 200, body: activeRow }, '7b22616d6f756e74223a2239393939397d');

    await expect(main([IDENTITY, METHOD_ID])).rejects.toThrow(/refusing to sign/i);

    expect(fetchMock.mock.calls.some(([url]) => String(url) === `${API}/auth/verify`)).toBe(false);
  });

  it('refuses a well-formed lolipay challenge minted for another account, which is what a relayed one looks like', async () => {
    const fetchMock = stubFetch({ status: 200, body: activeRow }, challengeFor(Keypair.random().publicKey()));

    await expect(main([IDENTITY, METHOD_ID])).rejects.toThrow(/refusing to sign/i);

    expect(fetchMock.mock.calls.some(([url]) => String(url) === `${API}/auth/verify`)).toBe(false);
  });

  it('refuses to follow a redirect on either call, so a relocated responder cannot answer for the coordinator', async () => {
    const fetchMock = stubFetch({ status: 200, body: activeRow });

    await main([IDENTITY, METHOD_ID]);

    expect(fetchMock.mock.calls.length).toBe(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).redirect).toBe('error');
    }
  });

  it('says out loud that the row is now active, rather than leaving an operator to read a status code', async () => {
    stubFetch({ status: 200, body: activeRow });

    await main([IDENTITY, METHOD_ID]);

    expect(printed()).toMatch(/OK: active=true/);
    expect(process.exitCode).toBe(0);
  });

  it('never prints the payment destination it just activated, on success', async () => {
    stubFetch({ status: 200, body: activeRow });

    await main([IDENTITY, METHOD_ID]);

    expect(printed()).not.toContain(DESTINATION);
    expect(printed()).toContain(METHOD_ID);
  });

  it('exits non-zero when the coordinator refuses, instead of reporting success', async () => {
    stubFetch({ status: 403, body: JSON.stringify({ message: 'Forbidden resource' }) });

    await main([IDENTITY, METHOD_ID]);

    expect(process.exitCode).toBe(1);
    expect(printed()).toMatch(/FAILED/);
    expect(printed()).toContain('Forbidden resource');
  });

  it('exits non-zero when a 200 hands back a row that is still inactive, and says so instead of printing the row', async () => {
    stubFetch({ status: 200, body: inactiveRow });

    await main([IDENTITY, METHOD_ID]);

    expect(process.exitCode).toBe(1);
    expect(printed()).toMatch(/FAILED/);
    expect(printed()).not.toContain(DESTINATION);
  });

  it.each([
    ['neither argument', [] as string[]],
    ['an empty identity name', ['', METHOD_ID]],
    ['an identity name a keystore could read as a flag', ['-lolipay-attestor', METHOD_ID]],
    ['no method id at all', [IDENTITY]],
    ['a method id that is not a uuid', [IDENTITY, '../../admin/config']],
  ])('refuses %s, rather than asking the keystore for a key', async (_what, argv) => {
    const fetchMock = stubFetch({ status: 200, body: activeRow });

    await expect(main(argv)).rejects.toThrow(/usage/i);

    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the seed out of scope when the keystore read fails, however the failure is later printed', async () => {
    execFileSyncMock.mockImplementation(() => {
      const failure = new Error('Command failed: stellar keys secret') as Error & { stdout?: string; output?: string[] };
      failure.stdout = provider.secret();
      failure.output = ['', provider.secret(), ''];
      throw failure;
    });
    stubFetch({ status: 200, body: activeRow });

    const raised = await main([IDENTITY, METHOD_ID]).catch((err: unknown) => err);

    expect(JSON.stringify(raised, Object.getOwnPropertyNames(raised))).not.toContain(provider.secret());
    expect((raised as Error).message).toMatch(/could not read keystore identity "e2e-provider"/);
  });
});
