import { StellarToml } from '@stellar/stellar-sdk';
import { checkAnchorIdentity } from './consistency';

const PROBE_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const TOML = [
  'NETWORK_PASSPHRASE="Test SDF Network ; September 2015"',
  'SIGNING_KEY="GBS7GJRD4NXT6GNEP7ODBMK63P72NRML6NQMJSG7ZNHIUYJW2XJCM64C"',
  'WEB_AUTH_ENDPOINT="https://api.lolipay.app/auth"',
].join('\n');

const PARSED: Record<string, string> = {
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  SIGNING_KEY: 'GBS7GJRD4NXT6GNEP7ODBMK63P72NRML6NQMJSG7ZNHIUYJW2XJCM64C',
  WEB_AUTH_ENDPOINT: 'https://api.lolipay.app/auth',
};

function fetcher(challenge: unknown) {
  return async () => ({ ok: true, text: async () => JSON.stringify(challenge) }) as any;
}

describe('the anchor is asked whether it still agrees with itself', () => {
  it('reports nothing when the toml and the live challenge name the same key', async () => {
    const problems = await checkAnchorIdentity('lolipay.app', {
      resolveToml: async () => PARSED,
      fetchImpl: fetcher({
        transaction: 'x',
        network_passphrase: 'Test SDF Network ; September 2015',
      }),
      readChallenge: () => ({
        source: 'GBS7GJRD4NXT6GNEP7ODBMK63P72NRML6NQMJSG7ZNHIUYJW2XJCM64C',
        webAuthDomain: 'api.lolipay.app',
        homeDomain: 'lolipay.app',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }),
    });

    expect(problems).toEqual([]);
  });

  it('names both keys when the toml advertises one and the challenge is signed by another', async () => {
    const problems = await checkAnchorIdentity('lolipay.app', {
      resolveToml: async () => PARSED,
      fetchImpl: fetcher({
        transaction: 'x',
        network_passphrase: 'Test SDF Network ; September 2015',
      }),
      readChallenge: () => ({
        source: 'GA3HXXEEV5SSEIVYNV662BXFVWRGPFRUFV6BAEZ34DVBHINOQ233JPC7',
        webAuthDomain: 'api.lolipay.app',
        homeDomain: 'lolipay.app',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }),
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('GBS7GJRD');
    expect(problems[0]).toContain('GA3HXXEE');
  });

  it('throws rather than returning an empty list when it cannot reach the anchor', async () => {
    await expect(
      checkAnchorIdentity('lolipay.app', {
        resolveToml: async () => {
          throw new Error('connection refused');
        },
      }),
    ).rejects.toThrow(/connection refused/);
  });

  it('throws when the toml advertises no auth endpoint, rather than calling that agreement', async () => {
    await expect(
      checkAnchorIdentity('lolipay.app', {
        resolveToml: async () => ({ NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015' }),
        fetchImpl: fetcher({}),
      }),
    ).rejects.toThrow(/WEB_AUTH_ENDPOINT/);
  });
});

describe('the endpoint the toml advertises is only ever fetched over https', () => {
  const CHALLENGE = {
    transaction: 'x',
    network_passphrase: 'Test SDF Network ; September 2015',
  };

  function reader(webAuthDomain: string) {
    return () => ({
      source: 'GBS7GJRD4NXT6GNEP7ODBMK63P72NRML6NQMJSG7ZNHIUYJW2XJCM64C',
      webAuthDomain,
      homeDomain: 'lolipay.app',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
  }

  it('reports a problem without sending the request when the toml advertises a plaintext endpoint', async () => {
    const sent: string[] = [];

    const problems = await checkAnchorIdentity('lolipay.app', {
      resolveToml: async () => ({
        ...PARSED,
        WEB_AUTH_ENDPOINT: 'http://169.254.169.254/latest/meta-data/',
      }),
      fetchImpl: async (url: string) => {
        sent.push(url);
        return { ok: true, text: async () => JSON.stringify(CHALLENGE) };
      },
      readChallenge: reader('169.254.169.254'),
    });

    expect(sent).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('169.254.169.254');
  });

  it('adds the probe account as a query parameter, so an endpoint that already carries a query still asks for the account', async () => {
    const sent: string[] = [];

    await checkAnchorIdentity('lolipay.app', {
      resolveToml: async () => ({
        ...PARSED,
        WEB_AUTH_ENDPOINT: 'https://api.lolipay.app/auth?x=1',
      }),
      fetchImpl: async (url: string) => {
        sent.push(url);
        return { ok: true, text: async () => JSON.stringify(CHALLENGE) };
      },
      readChallenge: reader('api.lolipay.app'),
    });

    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]).searchParams.get('account')).toBe(PROBE_ACCOUNT);
    expect(new URL(sent[0]).searchParams.get('x')).toBe('1');
  });

  it('asks the toml resolver to follow no redirect at all', async () => {
    const resolve = jest
      .spyOn(StellarToml.Resolver, 'resolve')
      .mockResolvedValue(PARSED as unknown as StellarToml.Api.StellarToml);

    try {
      await checkAnchorIdentity('lolipay.app', {
        fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(CHALLENGE) }),
        readChallenge: reader('api.lolipay.app'),
      });

      expect(resolve).toHaveBeenCalledWith(
        'lolipay.app',
        expect.objectContaining({ allowedRedirects: 0 }),
      );
    } finally {
      resolve.mockRestore();
    }
  });
});

describe('the endpoint the toml advertises is fetched once, never followed elsewhere', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('asks fetch to reject a redirect, so the endpoint the toml advertises cannot be followed to a second host', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({ transaction: 'x', network_passphrase: 'Test SDF Network ; September 2015' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await checkAnchorIdentity('lolipay.app', {
      resolveToml: async () => PARSED,
      readChallenge: () => ({
        source: 'GBS7GJRD4NXT6GNEP7ODBMK63P72NRML6NQMJSG7ZNHIUYJW2XJCM64C',
        webAuthDomain: 'api.lolipay.app',
        homeDomain: 'lolipay.app',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://api.lolipay.app/auth?account='),
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});
