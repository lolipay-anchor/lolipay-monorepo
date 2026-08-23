import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Keypair, Networks, Transaction, WebAuth } from '@stellar/stellar-sdk';
import { Sep10Service } from './sep10.service';

const SERVER = Keypair.random();
const CLIENT = Keypair.random();
const HOME_DOMAIN = 'lolipay.app';
const WEB_AUTH_DOMAIN = 'api.lolipay.app';

function makeService(overrides: Record<string, unknown> = {}) {
  const cfg = {
    sep10SigningKey: SERVER.secret(),
    anchorHomeDomain: HOME_DOMAIN,
    sep10WebAuthDomain: WEB_AUTH_DOMAIN,
    networkPassphrase: Networks.TESTNET,
    ...overrides,
  } as any;
  return new Sep10Service(cfg);
}

function challengeFor(account = CLIENT.publicKey(), opts = {}) {
  const res = makeService().buildChallenge(account, opts);
  return {
    res,
    tx: new Transaction(res.transaction, Networks.TESTNET),
  };
}

describe('the challenge has the shape the acceptance suite reads', () => {
  it('is sourced by the server signing key', () => {
    expect(challengeFor().tx.source).toBe(SERVER.publicKey());
  });

  it('carries sequence number zero, so it can never be submitted', () => {
    expect(challengeFor().tx.sequence).toBe('0');
  });

  it('holds the challenge open for the 900 seconds SEP-10 recommends, from now', () => {
    const before = Math.floor(Date.now() / 1000);
    const { tx } = challengeFor();

    expect(tx.timeBounds?.maxTime).toBeTruthy();
    expect(Number(tx.timeBounds?.minTime)).toBeGreaterThanOrEqual(before);
    expect(Number(tx.timeBounds?.maxTime) - Number(tx.timeBounds?.minTime)).toBe(900);
  });

  it('names the home domain in the first operation, sourced by the client', () => {
    const [op] = challengeFor().tx.operations;

    expect(op.type).toBe('manageData');
    expect((op as any).name).toBe(`${HOME_DOMAIN} auth`);
    expect(op.source).toBe(CLIENT.publicKey());
  });

  it('puts 48 random bytes in the first operation, base64 encoded', () => {
    const [op] = challengeFor().tx.operations;
    const nonce = Buffer.from((op as any).value).toString();

    expect(nonce).toHaveLength(64);
    expect(Buffer.from(nonce, 'base64')).toHaveLength(48);
  });

  it('gives two challenges two different nonces', () => {
    const first = Buffer.from((challengeFor().tx.operations[0] as any).value).toString();
    const second = Buffer.from((challengeFor().tx.operations[0] as any).value).toString();

    expect(first).not.toBe(second);
  });

  it('names the web auth domain in a server-sourced operation with an explicit source', () => {
    const op = challengeFor().tx.operations.find(
      (o) => (o as any).name === 'web_auth_domain',
    ) as any;

    expect(op).toBeDefined();
    expect(Buffer.from(op.value).toString()).toBe(WEB_AUTH_DOMAIN);
    expect(op.source).toBe(SERVER.publicKey());
  });

  it('is signed exactly once, and the reader the suite uses accepts that signature', () => {
    const { res, tx } = challengeFor();

    expect(tx.signatures).toHaveLength(1);
    expect(() =>
      WebAuth.readChallengeTx(
        res.transaction,
        SERVER.publicKey(),
        Networks.TESTNET,
        [HOME_DOMAIN],
        WEB_AUTH_DOMAIN,
      ),
    ).not.toThrow();
  });

  it('answers with the transaction and the network passphrase, and nothing else', () => {
    const { res } = challengeFor();

    expect(Object.keys(res).sort()).toEqual(['network_passphrase', 'transaction']);
    expect(res.network_passphrase).toBe(Networks.TESTNET);
  });
});

describe('the challenge endpoint refuses what it cannot honour', () => {
  it('refuses an account that is not a Stellar address', () => {
    expect(() => makeService().buildChallenge('not-an-account', {})).toThrow(
      BadRequestException,
    );
  });

  it('refuses an account whose checksum does not hold', () => {
    const bad = CLIENT.publicKey().slice(0, -1) + (CLIENT.publicKey().endsWith('A') ? 'B' : 'A');

    expect(() => makeService().buildChallenge(bad, {})).toThrow(BadRequestException);
  });

  it('refuses a memo that is not a number', () => {
    expect(() => makeService().buildChallenge(CLIENT.publicKey(), { memo: 'abc' })).toThrow(
      BadRequestException,
    );
  });

  it('refuses a memo alongside a muxed account, which SEP-10 forbids', () => {
    const muxed = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK';

    expect(() => makeService().buildChallenge(muxed, { memo: '17' })).toThrow(
      BadRequestException,
    );
  });

  it('accepts a numeric memo on an ordinary account', () => {
    const { tx } = challengeFor(CLIENT.publicKey(), { memo: '17509749319012223907' });

    expect(tx.source).toBe(SERVER.publicKey());
  });

  it('starts without a signing key, because the rest of the service still works', () => {
    expect(() => makeService({ sep10SigningKey: undefined })).not.toThrow();
  });

  it('but answers 503 rather than a challenge it cannot sign', () => {
    const svc = makeService({ sep10SigningKey: undefined });

    expect(() => svc.buildChallenge(CLIENT.publicKey(), {})).toThrow(
      ServiceUnavailableException,
    );
    expect(svc.isConfigured).toBe(false);
  });

  it('refuses a signing key that is not a Stellar seed', () => {
    expect(() => makeService({ sep10SigningKey: 'not-a-seed' })).toThrow(/SEP10_SIGNING_KEY/);
  });

  it('refuses a signing key that is a public key rather than a seed', () => {
    expect(() => makeService({ sep10SigningKey: SERVER.publicKey() })).toThrow(
      /SEP10_SIGNING_KEY/,
    );
  });
});

describe('a memo must be a number the ledger can actually hold', () => {
  it('accepts the largest unsigned 64-bit value', () => {
    const { tx } = challengeFor(CLIENT.publicKey(), { memo: '18446744073709551615' });

    expect(tx.source).toBe(SERVER.publicKey());
  });

  it('refuses one above it with a 400, not a 500 from deep in the SDK', () => {
    expect(() =>
      makeService().buildChallenge(CLIENT.publicKey(), { memo: '18446744073709551616' }),
    ).toThrow(BadRequestException);
  });

  it('refuses a memo of only zeroes padded past the range', () => {
    expect(() =>
      makeService().buildChallenge(CLIENT.publicKey(), { memo: '99999999999999999999' }),
    ).toThrow(BadRequestException);
  });
});

describe('the domains it signs into a challenge must be bare hosts', () => {
  it.each([
    ['a scheme', 'https://lolipay.app'],
    ['a trailing slash', 'lolipay.app/'],
    ['a path', 'lolipay.app/auth'],
    ['whitespace', 'lolipay.app '],
    ['an uppercase host the suite would lowercase', 'LOLIPAY.APP'],
    ['an internal space', 'lolipay.app auth'],
    ['a query marker', 'lolipay.app?x=1'],
    ['a fragment', 'lolipay.app#f'],
    ['more characters than a data key can hold', `${'a'.repeat(60)}.app`],
  ])('refuses a home domain carrying %s', (_n, value) => {
    expect(() => makeService({ anchorHomeDomain: value })).toThrow(/ANCHOR_HOME_DOMAIN/);
  });

  it.each([
    ['a scheme', 'https://api.lolipay.app'],
    ['a trailing slash', 'api.lolipay.app/'],
  ])('refuses a web auth domain carrying %s', (_n, value) => {
    expect(() => makeService({ sep10WebAuthDomain: value })).toThrow(/SEP10_WEB_AUTH_DOMAIN/);
  });

  it('accepts the bare hosts it is meant to have', () => {
    expect(() => makeService()).not.toThrow();
  });
});

describe('what the challenge is signed for is pinned, not assumed', () => {
  it('builds a challenge for a muxed account, sourced by that muxed address', () => {
    const muxed = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK';

    const { tx } = challengeFor(muxed);

    expect(tx.operations[0].source).toBe(muxed);
  });

  it('writes the memo it accepted into the transaction', () => {
    const { tx } = challengeFor(CLIENT.publicKey(), { memo: '17509749319012223907' });

    expect(tx.memo.type).toBe('id');
    expect(tx.memo.value).toBe('17509749319012223907');
  });

  it('is not configured when a domain is missing, and says so rather than guessing', () => {
    const svc = makeService({ anchorHomeDomain: undefined });

    expect(svc.isConfigured).toBe(false);
    expect(() => svc.buildChallenge(CLIENT.publicKey(), {})).toThrow(
      ServiceUnavailableException,
    );
  });
});

