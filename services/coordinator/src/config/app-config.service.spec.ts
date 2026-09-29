import { readFileSync } from 'fs';
import { join } from 'path';
import { AppConfigService, corsAllowlist } from './app-config.service';

const OUR_ORIGINS = [
  'https://app.lolipay.app',
  'https://lp.lolipay.app',
  'https://admin.lolipay.app',
  'https://lolipay.app',
];

describe('the allowlist carries the origins we own, whatever the environment says', () => {
  it.each([undefined, null, '', '   ', ','])(
    'serves every origin we own when the env var is %p',
    (raw) => {
      expect(corsAllowlist(raw)).toEqual(OUR_ORIGINS);
    },
  );

  it('includes the apex, which is where the landing page rate widget calls from', () => {
    expect(corsAllowlist(undefined)).toContain('https://lolipay.app');
  });

  it('keeps an env-supplied origin, and keeps it FIRST so corsOrigins[0] stays the env subject', () => {
    const list = corsAllowlist('https://staging.example');

    expect(list[0]).toBe('https://staging.example');
    expect(list.indexOf('https://app.lolipay.app')).toBeGreaterThan(0);
  });

  it('appends rather than prepends for every origin we own, not merely the first', () => {
    const list = corsAllowlist('https://staging.example');

    for (const ours of OUR_ORIGINS) {
      expect(list.indexOf(ours)).toBeGreaterThan(list.indexOf('https://staging.example'));
    }
  });

  it('trims and drops blanks around an env-supplied origin', () => {
    expect(corsAllowlist(' https://staging.example ,, ')).toEqual([
      'https://staging.example',
      ...OUR_ORIGINS,
    ]);
  });

  it('collapses an env value that repeats one we own, so cors never sees a duplicate', () => {
    const list = corsAllowlist('https://app.lolipay.app');

    expect(list.filter((o) => o === 'https://app.lolipay.app')).toHaveLength(1);
    expect(list).toEqual(OUR_ORIGINS);
  });

  it('never ships localhost, which belongs in a developer env file', () => {
    const list = corsAllowlist(undefined);

    expect(list).toHaveLength(OUR_ORIGINS.length);
    expect(list.join(' ')).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  it('serves the apex but not www, which answers 301 and so never becomes a document origin', () => {
    const list = corsAllowlist(undefined);

    expect(list).toContain('https://lolipay.app');
    expect(list).not.toContain('https://www.lolipay.app');
  });

  it('adds to what the env supplies and subtracts nothing from it', () => {
    expect(corsAllowlist('https://staging.example,https://other.example')).toEqual([
      'https://staging.example',
      'https://other.example',
      ...OUR_ORIGINS,
    ]);
  });
});

describe('the http layer serves the same allowlist, through AppConfigService', () => {
  const withEnv = (env: Record<string, string | undefined>) =>
    new AppConfigService({ get: (k: string) => env[k] } as any);

  it('serves every origin we own when nothing is set, because this getter feeds applyCors', () => {
    expect(withEnv({}).corsOrigins).toEqual(OUR_ORIGINS);
  });

  it('keeps an env-supplied origin at index 0, which is what corsOrigins[0] is read for', () => {
    const list = withEnv({ CORS_ORIGINS: 'https://staging.example' }).corsOrigins;

    expect(list[0]).toBe('https://staging.example');
    expect(list.indexOf('https://lolipay.app')).toBeGreaterThan(0);
  });
});

describe('the socket handshake derives its allowlist from the same function', () => {
  const gateway = readFileSync(join(__dirname, '../realtime/realtime.gateway.ts'), 'utf8');

  it('calls the shared function rather than splitting the env var itself', () => {
    expect(gateway).toMatch(/=\s*corsAllowlist\(process\.env\.CORS_ORIGINS\)/);
    expect(gateway).not.toMatch(/process\.env\.CORS_ORIGINS[^)]*\.split/);
  });
});

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

describe('a required config getter throws rather than defaulting', () => {
  const withEnv = (env: Record<string, string | undefined>) =>
    new AppConfigService({ get: (k: string) => env[k] } as any);

  it.each([undefined, ''])('throws for STELLAR_RPC_URL when it is %p', (value) => {
    expect(() => withEnv({ STELLAR_RPC_URL: value }).rpcUrl).toThrow(/Missing env STELLAR_RPC_URL/);
  });

  it('returns the value when it is set, so the throw is not unconditional', () => {
    expect(withEnv({ STELLAR_RPC_URL: 'https://rpc.example.test' }).rpcUrl).toBe('https://rpc.example.test');
  });
});
