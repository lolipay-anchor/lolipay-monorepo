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
