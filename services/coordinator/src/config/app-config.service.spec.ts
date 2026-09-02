import { AppConfigService } from './app-config.service';

describe('AppConfigService.escrowContractIdsExtra', () => {
  function makeCfg(value: string | undefined) {
    const c = {
      get: (key: string) => (key === 'ESCROW_CONTRACT_IDS_EXTRA' ? value : undefined),
    } as any;
    return new AppConfigService(c);
  }

  it('defaults to an empty array when unset', () => {
    expect(makeCfg(undefined).escrowContractIdsExtra).toEqual([]);
  });

  it('defaults to an empty array when the env var is an empty string', () => {
    expect(makeCfg('').escrowContractIdsExtra).toEqual([]);
  });

  it('parses a single contract id', () => {
    expect(makeCfg('CONE').escrowContractIdsExtra).toEqual(['CONE']);
  });

  it('parses a comma-separated list, trimming whitespace', () => {
    expect(makeCfg('CONE, CTWO ,CTHREE').escrowContractIdsExtra).toEqual(['CONE', 'CTWO', 'CTHREE']);
  });

  it('drops empty entries from stray/trailing commas', () => {
    expect(makeCfg('CONE,,CTWO,').escrowContractIdsExtra).toEqual(['CONE', 'CTWO']);
  });

  it('does NOT throw when unset, unlike required getters (escrowContractIdsExtra is optional)', () => {
    expect(() => makeCfg(undefined).escrowContractIdsExtra).not.toThrow();
  });
});

describe('AppConfigService.escrowContractIdsExtra (process.env boot path)', () => {
  it('is an empty array by default in the test environment', () => {
    const { ConfigService } = require('@nestjs/config');
    const cfg = new AppConfigService(new ConfigService());
    expect(cfg.escrowContractIdsExtra).toEqual([]);
  });
});

describe('a required config value stops the process rather than defaulting', () => {
  const withEnv = (env: Record<string, string | undefined>) =>
    new AppConfigService({ get: (k: string) => env[k] } as any);

  it.each([undefined, ''])('throws for STELLAR_RPC_URL when it is %p', (value) => {
    expect(() => withEnv({ STELLAR_RPC_URL: value }).rpcUrl).toThrow(/Missing env STELLAR_RPC_URL/);
  });

  it('returns the value when it is set, so the throw is not unconditional', () => {
    expect(withEnv({ STELLAR_RPC_URL: 'https://rpc.example.test' }).rpcUrl).toBe('https://rpc.example.test');
  });
});
