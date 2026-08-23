import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {
  Account as StellarAccount,
  Keypair,
  MuxedAccount,
  Networks,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { Sep10Service } from './sep10.service';

const SERVER = Keypair.random();
const CLIENT = Keypair.random();
const HOME_DOMAIN = 'lolipay.app';
const WEB_AUTH_DOMAIN = 'api.lolipay.app';

type Account = { signers: { key: string; weight: number; type: string }[]; medThreshold: number };

function makeDeps(account: Account | null | Error = null) {
  const accounts = {
    load: jest.fn(async () => {
      if (account instanceof Error) throw account;
      return account;
    }),
  };
  const people = {
    proveWallet: jest.fn().mockResolvedValue({ id: 'person-1' }),
    lookupPerson: jest.fn().mockResolvedValue({ id: 'person-1' }),
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue('a-token') };
  const consumed = { consume: jest.fn().mockResolvedValue(true) };
  return { accounts, people, jwt, consumed };
}

function makeService(deps = makeDeps(), overrides: Record<string, unknown> = {}) {
  const cfg = {
    sep10SigningKey: SERVER.secret(),
    anchorHomeDomain: HOME_DOMAIN,
    sep10WebAuthDomain: WEB_AUTH_DOMAIN,
    networkPassphrase: Networks.TESTNET,
    jwtTtl: 900,
    jwtIssuer: 'https://lolipay.app',
    jwtAudience: 'lolipay-app',
    ...overrides,
  } as any;
  return new Sep10Service(
    cfg,
    deps.accounts as any,
    deps.people as any,
    deps.jwt as any,
    deps.consumed as any,
  );
}

function signedBy(xdr: string, ...keys: Keypair[]): string {
  const tx = new Transaction(xdr, Networks.TESTNET);
  keys.forEach((k) => tx.sign(k));
  return tx.toXdr();
}

function challenge(svc: Sep10Service, account = CLIENT.publicKey(), opts = {}) {
  return svc.buildChallenge(account, opts).transaction;
}

describe('an account that has never existed on chain can still authenticate', () => {
  it('issues a token for a correctly signed challenge from an unfunded account', async () => {
    const deps = makeDeps(null);
    const svc = makeService(deps);

    const token = await svc.issueToken(signedBy(challenge(svc), CLIENT));

    expect(token).toBe('a-token');
    expect(deps.accounts.load).toHaveBeenCalledWith(CLIENT.publicKey());
  });

  it('refuses when an unfunded account brings a second signature', async () => {
    const svc = makeService(makeDeps(null));
    const other = Keypair.random();

    await expect(svc.issueToken(signedBy(challenge(svc), CLIENT, other))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses when nobody but the server signed', async () => {
    const svc = makeService(makeDeps(null));

    await expect(svc.issueToken(challenge(svc))).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('a funded account is judged against its own signers and threshold', () => {
  const funded = (signers: Account['signers'], medThreshold: number) => ({ signers, medThreshold });

  it('issues a token when a non-master signer carries enough weight', async () => {
    const signer = Keypair.random();
    const svc = makeService(
      makeDeps(
        funded(
          [
            { key: CLIENT.publicKey(), weight: 0, type: 'ed25519_public_key' },
            { key: signer.publicKey(), weight: 2, type: 'ed25519_public_key' },
          ],
          2,
        ),
      ),
    );

    await expect(svc.issueToken(signedBy(challenge(svc), signer))).resolves.toBe('a-token');
  });

  it('refuses when the signatures fall short of the medium threshold', async () => {
    const signer = Keypair.random();
    const svc = makeService(
      makeDeps(funded([{ key: signer.publicKey(), weight: 1, type: 'ed25519_public_key' }], 2)),
    );

    await expect(svc.issueToken(signedBy(challenge(svc), signer))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('issues a token when several non-master signers together clear the threshold', async () => {
    const a = Keypair.random();
    const b = Keypair.random();
    const svc = makeService(
      makeDeps(
        funded(
          [
            { key: a.publicKey(), weight: 1, type: 'ed25519_public_key' },
            { key: b.publicKey(), weight: 1, type: 'ed25519_public_key' },
          ],
          2,
        ),
      ),
    );

    await expect(svc.issueToken(signedBy(challenge(svc), a, b))).resolves.toBe('a-token');
  });

  it('refuses when one signer signs twice to fake the weight', async () => {
    const a = Keypair.random();
    const svc = makeService(
      makeDeps(funded([{ key: a.publicKey(), weight: 1, type: 'ed25519_public_key' }], 2)),
    );

    await expect(svc.issueToken(signedBy(challenge(svc), a, a))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('a challenge that is not ours is not a challenge', () => {
  it('refuses one signed by somebody else pretending to be the server', async () => {
    const impostor = Keypair.random();
    const svc = makeService(makeDeps(null));
    const foreign = new Sep10Service(
      {
        sep10SigningKey: impostor.secret(),
        anchorHomeDomain: HOME_DOMAIN,
        sep10WebAuthDomain: WEB_AUTH_DOMAIN,
        networkPassphrase: Networks.TESTNET,
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      svc.issueToken(signedBy(challenge(foreign), CLIENT)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses one built for a different web auth domain', async () => {
    const svc = makeService(makeDeps(null));
    const elsewhere = new Sep10Service(
      {
        sep10SigningKey: SERVER.secret(),
        anchorHomeDomain: HOME_DOMAIN,
        sep10WebAuthDomain: 'auth.somewhere-else.example',
        networkPassphrase: Networks.TESTNET,
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      svc.issueToken(signedBy(challenge(elsewhere), CLIENT)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a transaction that is not base64 at all', async () => {
    const svc = makeService(makeDeps(null));

    await expect(svc.issueToken('not-a-transaction')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses one whose time bound passed beyond the clock-skew grace', async () => {
    const svc = makeService(makeDeps(null));
    const original = new Transaction(challenge(svc), Networks.TESTNET);
    const stale = TransactionBuilder.cloneFrom(original, {
      timebounds: { minTime: 1, maxTime: 2 },
    }).build();
    stale.sign(SERVER);

    await expect(svc.issueToken(signedBy(stale.toXdr(), CLIENT))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('the chain being unreachable is never a reason to hand out a token', () => {
  it('answers 503 when the account cannot be loaded', async () => {
    const deps = makeDeps(new Error('horizon is down'));
    const svc = makeService(deps);

    await expect(svc.issueToken(signedBy(challenge(svc), CLIENT))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(deps.jwt.signAsync).not.toHaveBeenCalled();
  });
});

describe('the token names who proved what', () => {
  it('mints an anchor-class token whose subject is the account', async () => {
    const deps = makeDeps(null);
    const svc = makeService(deps);

    await svc.issueToken(signedBy(challenge(svc), CLIENT));

    expect(deps.jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sub: CLIENT.publicKey(), cls: 'sep10' }),
      expect.objectContaining({ issuer: 'https://lolipay.app/', audience: 'lolipay-app' }),
    );
  });

  it('appends the memo to the subject, which is what the suite parses', async () => {
    const deps = makeDeps(null);
    const svc = makeService(deps);

    await svc.issueToken(signedBy(challenge(svc, CLIENT.publicKey(), { memo: '17' }), CLIENT));

    expect(deps.jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sub: `${CLIENT.publicKey()}:17` }),
      expect.anything(),
    );
  });

  it('proves the wallet, without which the token it just minted would be refused', async () => {
    const deps = makeDeps(null);
    const svc = makeService(deps);

    await svc.issueToken(signedBy(challenge(svc), CLIENT));

    expect(deps.people.proveWallet).toHaveBeenCalledWith(CLIENT.publicKey(), 'SEP10');
  });

  it('refuses a challenge that has already been spent', async () => {
    const deps = makeDeps(null);
    deps.consumed.consume = jest.fn().mockResolvedValue(false);
    const svc = makeService(deps);

    await expect(svc.issueToken(signedBy(challenge(svc), CLIENT))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(deps.jwt.signAsync).not.toHaveBeenCalled();
  });
});

describe('a muxed address is many names for one set of keys', () => {
  const MUXED = new MuxedAccount(new StellarAccount(CLIENT.publicKey(), '0'), '17').accountId();

  it('binds identity to the account that holds the keys, not to the muxed name', async () => {
    const deps = makeDeps(null);
    const svc = makeService(deps);

    await svc.issueToken(signedBy(challenge(svc, MUXED), CLIENT));

    expect(deps.people.proveWallet).toHaveBeenCalledWith(CLIENT.publicKey(), 'SEP10');
  });

  it('still names the muxed address as the subject, which is what SEP-10 asks for', async () => {
    const deps = makeDeps(null);
    const svc = makeService(deps);

    await svc.issueToken(signedBy(challenge(svc, MUXED), CLIENT));

    expect(deps.people.proveWallet).toHaveBeenCalledWith(CLIENT.publicKey(), 'SEP10');
    expect(deps.jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sub: MUXED }),
      expect.anything(),
    );
  });

  it('authenticates a muxed address whose base account has never been funded', async () => {
    const deps = makeDeps(null);
    const svc = makeService(deps);

    await expect(svc.issueToken(signedBy(challenge(svc, MUXED), CLIENT))).resolves.toBe(
      'a-token',
    );
  });
});

describe('a revoked wallet does not get a fresh token', () => {
  it('refuses to mint for an address whose link is no longer active', async () => {
    const deps = makeDeps(null);
    deps.people.lookupPerson = jest.fn().mockResolvedValue(null);
    const svc = makeService(deps);

    await expect(svc.issueToken(signedBy(challenge(svc), CLIENT))).rejects.toThrow();
    expect(deps.jwt.signAsync).not.toHaveBeenCalled();
  });
});

