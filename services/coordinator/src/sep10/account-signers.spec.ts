import { Account, Keypair, MuxedAccount, Networks } from '@stellar/stellar-sdk';
import { AccountSignersService, baseStellarAccount } from './account-signers.service';

const KP = Keypair.random();
const MUXED = new MuxedAccount(new Account(KP.publicKey(), '0'), '17').accountId();

function makeService(horizonUrl = 'https://horizon.example/', responses: Record<string, any> = {}) {
  const cfg = { horizonUrl, networkPassphrase: Networks.TESTNET } as any;
  const calls: string[] = [];
  global.fetch = jest.fn(async (url: any) => {
    calls.push(String(url));
    const path = new URL(String(url)).pathname;
    const key = Object.keys(responses).find((k) => (k === '/' ? path === '/' : path.startsWith(k)));
    const r = key ? responses[key] : { status: 404, ok: false, json: async () => ({}) };
    return r as any;
  }) as any;
  return { svc: new AccountSignersService(cfg), calls };
}

const rootOk = {
  status: 200,
  ok: true,
  json: async () => ({ network_passphrase: Networks.TESTNET }),
};

describe('the base account is what identity is keyed on', () => {
  it('resolves a muxed address to the account that actually holds the keys', () => {
    expect(baseStellarAccount(MUXED)).toBe(KP.publicKey());
  });

  it('leaves an ordinary address alone', () => {
    expect(baseStellarAccount(KP.publicKey())).toBe(KP.publicKey());
  });
});

describe('the account loader asks the right chain, at the right address', () => {
  it('does not double the slash when the configured url ends in one', async () => {
    const { svc, calls } = makeService('https://horizon.example/', { '/': rootOk });

    await svc.load(KP.publicKey()).catch(() => undefined);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(new URL(call).pathname.startsWith('//')).toBe(false);
    }
  });

  it('refuses to answer when the chain is not the one we are configured for', async () => {
    const { svc } = makeService('https://horizon.example', {
      '/': {
        status: 200,
        ok: true,
        json: async () => ({ network_passphrase: Networks.PUBLIC }),
      },
    });

    await expect(svc.load(KP.publicKey())).rejects.toThrow(/network/i);
  });

  it('treats a 404 as an account that does not exist yet', async () => {
    const { svc } = makeService('https://horizon.example', { '/': rootOk });

    await expect(svc.load(KP.publicKey())).resolves.toBeNull();
  });

  it('refuses a body with no thresholds rather than assuming zero', async () => {
    const { svc } = makeService('https://horizon.example', {
      '/': rootOk,
      '/accounts/': {
        status: 200,
        ok: true,
        json: async () => ({ signers: [{ key: KP.publicKey(), weight: 1, type: 'x' }] }),
      },
    });

    await expect(svc.load(KP.publicKey())).rejects.toThrow(/threshold/i);
  });

  it('looks up the base account for a muxed address', async () => {
    const { svc, calls } = makeService('https://horizon.example', { '/': rootOk });

    await svc.load(MUXED).catch(() => undefined);

    expect(calls.some((c) => c.includes(KP.publicKey()))).toBe(true);
    expect(calls.some((c) => c.includes(MUXED))).toBe(false);
  });
});
