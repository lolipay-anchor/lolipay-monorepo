import { StellarReadService } from './stellar-read.service';

const CONTRACT = 'CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z';
const RESOLVER = 'GBDAT5C6MBMHCFEHERC6KRDTZUORG6W55D47HIPFVQS5DKMZKJPAFC3R';
const ATTESTOR = 'GD2XB6Q3SQYGTCUPA5W357H4NNKQ2F4XGTILDM6EJH2F37YQOLOPTPP2';

function svc(cfg: unknown) {
  const s = Object.create(StellarReadService.prototype) as any;
  s.simulateCall = jest.fn(async () => cfg);
  return s as StellarReadService;
}

const FULL = { resolver: RESOLVER, fiat_attestor: ATTESTOR, admin: 'GADMIN', paused: false };

describe('reading a role out of the escrow reads THAT role, not the one beside it', () => {
  it('takes the resolver from resolver, never from fiat_attestor', async () => {
    await expect(svc(FULL).readEscrowResolver(CONTRACT)).resolves.toBe(RESOLVER);
    expect(RESOLVER).not.toBe(ATTESTOR);
  });

  it('takes the attestor from fiat_attestor, never from resolver', async () => {
    await expect(svc(FULL).readEscrowFiatAttestor(CONTRACT)).resolves.toBe(ATTESTOR);
  });

  it('refuses a config whose resolver is missing, empty or not a string', async () => {
    for (const bad of [{}, { resolver: '' }, { resolver: 123 }, { resolver: null }, null]) {
      await expect(svc(bad).readEscrowResolver(CONTRACT)).rejects.toThrow(/no resolver/);
    }
  });

  it('refuses a config whose fiat_attestor is missing, empty or not a string', async () => {
    for (const bad of [{}, { fiat_attestor: '' }, { fiat_attestor: 123 }, null]) {
      await expect(svc(bad).readEscrowFiatAttestor(CONTRACT)).rejects.toThrow(/no fiat_attestor/);
    }
  });

  it('names the contract it asked, so an operator can tell which deployment answered', async () => {
    await expect(svc({}).readEscrowResolver(CONTRACT)).rejects.toThrow(CONTRACT);
  });
});

describe('reading the fee defaults out of the escrow reads exactly what create_trade will require, in one call', () => {
  const WALLET = 'GBSYTTNQVWKH2DOIWXSE6UVJXRCUIXKSC5TBPYWNLCXLS35FKH7DNOHT';

  it('returns both defaults from a single get_config, so the fee and the wallet come from the same ledger', async () => {
    const s = svc({ default_platform_fee_bps: 30, default_platform_wallet: WALLET, resolver: 'GRES' });
    expect(await s.readEscrowPlatformDefaults('C')).toEqual({ platformFeeBps: 30, platformWallet: WALLET });
    expect((s as any).simulateCall).toHaveBeenCalledTimes(1);
    expect((await svc({ default_platform_fee_bps: 0n, default_platform_wallet: WALLET }).readEscrowPlatformDefaults('C')).platformFeeBps).toBe(0);
  });

  it('refuses a config whose default_platform_fee_bps is missing, null, empty, boolean, an array or negative, none of which is a fee of zero', async () => {
    for (const bad of [{}, { default_platform_fee_bps: null }, { default_platform_fee_bps: '' }, { default_platform_fee_bps: false }, { default_platform_fee_bps: [] }, { default_platform_fee_bps: -1 }, { default_platform_fee_bps: 1.5 }]) {
      await expect(svc({ default_platform_wallet: WALLET, ...bad }).readEscrowPlatformDefaults('C')).rejects.toThrow(/default_platform_fee_bps/);
    }
    await expect(svc(null).readEscrowPlatformDefaults('C')).rejects.toThrow(/default_platform_fee_bps/);
  });

  it('takes default_platform_wallet as any Stellar address, so a contract wallet on chain is reported as a divergence rather than as an unreadable config', async () => {
    const contractWallet = 'CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z';
    expect((await svc({ default_platform_fee_bps: 30, default_platform_wallet: contractWallet }).readEscrowPlatformDefaults('C')).platformWallet).toBe(contractWallet);
    for (const bad of [{}, { default_platform_wallet: '' }, { default_platform_wallet: 'not-an-address' }, { default_platform_wallet: null }]) {
      await expect(svc({ default_platform_fee_bps: 30, ...bad }).readEscrowPlatformDefaults('C')).rejects.toThrow(/default_platform_wallet/);
    }
  });
});
