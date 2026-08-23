import { compareAnchorIdentity } from './consistency';

const TOML = {
  SIGNING_KEY: 'GADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOZPI',
  WEB_AUTH_ENDPOINT: 'https://api.lolipay.app/auth',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
};

const CHALLENGE = {
  source: TOML.SIGNING_KEY,
  webAuthDomain: 'api.lolipay.app',
  homeDomain: 'lolipay.app',
  networkPassphrase: TOML.NETWORK_PASSPHRASE,
};

describe('the two processes must be saying the same thing', () => {
  const DOMAIN = 'lolipay.app';

  it('is satisfied when they agree', () => {
    expect(compareAnchorIdentity(TOML, CHALLENGE, DOMAIN)).toEqual([]);
  });

  it('names the signing key when the challenge is signed by a different one', () => {
    const problems = compareAnchorIdentity(TOML, {
      ...CHALLENGE,
      source: 'GBSYTTNQVWKH2DOIWXSE6UVJXRCUIXKSC5TBPYWNLCXLS35FKH7DNOHT',
    }, DOMAIN);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/SIGNING_KEY/);
  });

  it('names the web auth domain when it is not the host of the advertised endpoint', () => {
    const problems = compareAnchorIdentity(TOML, {
      ...CHALLENGE,
      webAuthDomain: 'auth.somewhere-else.example',
    }, DOMAIN);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/web_auth_domain/);
  });

  it('names the network when the two disagree about which chain this is', () => {
    const problems = compareAnchorIdentity(TOML, {
      ...CHALLENGE,
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    }, DOMAIN);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/network/i);
  });

  it('reports every disagreement at once, not just the first', () => {
    const problems = compareAnchorIdentity(TOML, {
      source: 'GBSYTTNQVWKH2DOIWXSE6UVJXRCUIXKSC5TBPYWNLCXLS35FKH7DNOHT',
      webAuthDomain: 'elsewhere.example',
      homeDomain: 'lolipay.app',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    }, DOMAIN);

    expect(problems).toHaveLength(3);
  });

  it('names the home domain when the challenge was built for a different one', () => {
    const problems = compareAnchorIdentity(TOML, {
      ...CHALLENGE,
      homeDomain: 'testnet.lolipay.app',
    }, DOMAIN);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/home domain/i);
  });

  it('refuses a toml with no signing key rather than reporting agreement', () => {
    const problems = compareAnchorIdentity({ ...TOML, SIGNING_KEY: undefined }, CHALLENGE, DOMAIN);

    expect(problems[0]).toMatch(/advertises no SIGNING_KEY/);
  });

  it('refuses a toml whose web auth endpoint is not a url', () => {
    const problems = compareAnchorIdentity(
      { ...TOML, WEB_AUTH_ENDPOINT: 'not-a-url' },
      CHALLENGE,
      DOMAIN,
    );

    expect(problems[0]).toMatch(/no usable WEB_AUTH_ENDPOINT/);
  });
});
