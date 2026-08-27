import { checkAnchorIdentity } from './consistency';

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
