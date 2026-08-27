import { ConfigBootService } from './config-boot.service';

const WALLET = 'GBSYTTNQVWKH2DOIWXSE6UVJXRCUIXKSC5TBPYWNLCXLS35FKH7DNOHT';
const OTHER_WALLET = 'GCMUR7GXQPMY4XSMHEQO4EHPGXQ72RQTLYSMJ2VQ7NPCBHKRJ7NTTUSD';

function makePrisma(row: Record<string, unknown>) {
  const configApi = {
    upsert: jest.fn(async (_args: any) => row),
    update: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
  };
  return { prisma: { config: configApi } as any, configApi };
}

function makeCfg(over: Record<string, unknown> = {}) {
  return {
    priceDeviationMaxBps: 100,
    platformWallet: WALLET,
    usdcAssetCode: 'USDC',
    usdcAssetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    ...over,
  } as any;
}

describe('ConfigBootService', () => {
  it('starts when the spread stays above the price-deviation allowance', async () => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    await expect(new ConfigBootService(prisma, makeCfg()).onModuleInit()).resolves.toBeUndefined();
  });

  it('refuses to start when the settlement asset has no issuer, because every trustline check would quietly fail', async () => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    await expect(
      new ConfigBootService(prisma, makeCfg({ usdcAssetIssuer: '' })).onModuleInit(),
    ).rejects.toThrow(/USDC_ASSET_ISSUER/);
  });

  it('refuses to start when the issuer is not a Stellar address', async () => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    await expect(
      new ConfigBootService(prisma, makeCfg({ usdcAssetIssuer: 'not-an-address' })).onModuleInit(),
    ).rejects.toThrow(/USDC_ASSET_ISSUER/);
  });

  it('refuses to start when the settlement asset has no code', async () => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    await expect(
      new ConfigBootService(prisma, makeCfg({ usdcAssetCode: '' })).onModuleInit(),
    ).rejects.toThrow(/USDC_ASSET_CODE/);
  });

  it('refuses to start when the spread does not cover the deviation allowance', async () => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 100, platformWallet: WALLET });
    await expect(new ConfigBootService(prisma, makeCfg()).onModuleInit()).rejects.toThrow(/INV-30\.1/);
  });

  it('materialises the Config row so the first quote does not race a lazy upsert', async () => {
    const { prisma, configApi } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    await new ConfigBootService(prisma, makeCfg()).onModuleInit();
    expect(configApi.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, update: {} }),
    );
  });

  it('seeds a newly created row with the validated platform wallet from the environment', async () => {
    const { prisma, configApi } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    await new ConfigBootService(prisma, makeCfg()).onModuleInit();
    expect(configApi.upsert.mock.calls[0][0].create).toEqual({ id: 1, platformWallet: WALLET });
  });

  it('refuses to start when the stored platform wallet is empty', async () => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: '' });
    await expect(new ConfigBootService(prisma, makeCfg()).onModuleInit()).rejects.toThrow(
      /platformWallet/,
    );
  });

  it('keeps a stored platform wallet that disagrees with the environment, and says so', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { prisma, configApi } = makePrisma({ id: 1, spreadBps: 150, platformWallet: OTHER_WALLET });

    await new ConfigBootService(prisma, makeCfg()).onModuleInit();

    expect(configApi.update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(OTHER_WALLET));
    warn.mockRestore();
  });

  it('stays quiet when the stored platform wallet matches the environment', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });

    await new ConfigBootService(prisma, makeCfg()).onModuleInit();

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('a stack that only pretends to screen must never be the one taking real money', () => {
  const PUBLIC = 'Public Global Stellar Network ; September 2015';
  const TESTNET = 'Test SDF Network ; September 2015';

  it('refuses to start on the public network while the stub is told to report screening', async () => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    const cfg = makeCfg({ networkPassphrase: PUBLIC, kycStubScreens: true });
    await expect(new ConfigBootService(prisma, cfg).onModuleInit()).rejects.toThrow(
      /KYC_STUB_SCREENS/,
    );
  });

  it('starts on the public network when the stub is not pretending', async () => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    const cfg = makeCfg({ networkPassphrase: PUBLIC, kycStubScreens: false });
    await expect(new ConfigBootService(prisma, cfg).onModuleInit()).resolves.toBeUndefined();
  });

  it('allows a test network to pretend, because there is no real money to protect there', async () => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    const cfg = makeCfg({ networkPassphrase: TESTNET, kycStubScreens: true });
    await expect(new ConfigBootService(prisma, cfg).onModuleInit()).resolves.toBeUndefined();
  });
});
