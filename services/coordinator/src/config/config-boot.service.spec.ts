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
    anchorBaseUrl: 'https://api.lolipay.app',
    rpcUrl: 'https://soroban-testnet.stellar.org',
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
  const vendor = { diditApiKey: 'k', diditWorkflowId: 'wf', diditWebhookSecret: 'shared' };

  const boot = (over: Record<string, unknown>) => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    return new ConfigBootService(prisma, makeCfg({ ...vendor, ...over })).onModuleInit();
  };

  it('refuses to start on the public network while pointed at a mocked environment', async () => {
    await expect(boot({ networkPassphrase: PUBLIC, diditEnvironment: 'sandbox' })).rejects.toThrow(
      /DIDIT_ENVIRONMENT/,
    );
  });

  it('refuses to start on the public network with no verification provider configured', async () => {
    await expect(
      boot({ networkPassphrase: PUBLIC, diditEnvironment: 'live', diditApiKey: '' }),
    ).rejects.toThrow(/identity verification/i);
  });

  it('starts on the public network when it is pointed at the real thing', async () => {
    await expect(
      boot({ networkPassphrase: PUBLIC, diditEnvironment: 'live' }),
    ).resolves.toBeUndefined();
  });

  it('refuses to start with a provider configured and no shared secret to trust it by', async () => {
    await expect(
      boot({ networkPassphrase: TESTNET, diditEnvironment: 'sandbox', diditWebhookSecret: '' }),
    ).rejects.toThrow(/DIDIT_WEBHOOK_SECRET/);
  });

  it('leaves a test network alone, because there is no real money there to protect', async () => {
    await expect(
      boot({ networkPassphrase: TESTNET, diditEnvironment: 'sandbox', diditApiKey: '' }),
    ).resolves.toBeUndefined();
  });
});

describe('an anchor that cannot name itself cannot serve SEP-24', () => {
  it('refuses to start without an absolute https base url', async () => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    await expect(
      new ConfigBootService(prisma, makeCfg({ anchorBaseUrl: '' })).onModuleInit(),
    ).rejects.toThrow(/ANCHOR_BASE_URL/);
  });

  it.each([
    ['a host smuggled behind credentials', 'https://api.lolipay.app@evil.com'],
    ['a bare scheme with no host', 'https://'],
    ['a query string a wallet would carry into the webview', 'https://api.lolipay.app?next=evil'],
    ['a fragment', 'https://api.lolipay.app#evil'],
  ])('refuses %s, because every URL handed to a wallet is built from this value', async (_n, value) => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    await expect(
      new ConfigBootService(prisma, makeCfg({ anchorBaseUrl: value })).onModuleInit(),
    ).rejects.toThrow(/ANCHOR_BASE_URL/);
  });

  it.each([
    ['a value that is not a url at all', 'not a url'],
    ['plain http, which the inherited upgrade-insecure-requests would break anyway', 'http://rpc.local:8000'],
    ['a data url, whose origin parses as the string null', 'data:text/html,x'],
    ['an endpoint whose api key rides in the userinfo', 'https://user:key@rpc.example.com'],
  ])(
    'refuses %s for STELLAR_RPC_URL, because the signing page hands it to the browser verbatim',
    async (_n, value) => {
      const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
      await expect(
        new ConfigBootService(prisma, makeCfg({ rpcUrl: value })).onModuleInit(),
      ).rejects.toThrow(/STELLAR_RPC_URL/);
    },
  );

  it('admits an https rpc endpoint that carries a path, which providers routinely use', async () => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    await expect(
      new ConfigBootService(prisma, makeCfg({ rpcUrl: 'https://rpc.example.com/soroban/rpc' })).onModuleInit(),
    ).resolves.toBeUndefined();
  });

  it('refuses a base url that is not https, because more_info_url must be absolute and trusted', async () => {
    const { prisma } = makePrisma({ id: 1, spreadBps: 150, platformWallet: WALLET });
    await expect(
      new ConfigBootService(prisma, makeCfg({ anchorBaseUrl: 'http://api.lolipay.app' })).onModuleInit(),
    ).rejects.toThrow(/ANCHOR_BASE_URL/);
  });
});
