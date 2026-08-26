import { readFileSync } from 'fs';
import { join } from 'path';

const compose = readFileSync(join(__dirname, '../../docker-compose.prod.yml'), 'utf8');

function settingFor(key: string): string | undefined {
  return compose
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${key}:`));
}

describe('the deployment must not decide what the environment decides', () => {
  it('reads the asset code from the environment rather than fixing it', () => {
    const line = settingFor('USDC_ASSET_CODE');
    expect(line).toBeDefined();
    expect(line).toMatch(/\$\{USDC_ASSET_CODE/);
  });

  it('supplies no default for either half of the asset identity, because a default is how a wrong one shipped', () => {
    for (const key of ['USDC_ASSET_CODE', 'USDC_ASSET_ISSUER']) {
      expect(settingFor(key) ?? '').not.toMatch(/:-/);
    }
    const source = readFileSync(join(__dirname, 'app-config.service.ts'), 'utf8');
    expect(source).not.toMatch(/USDC_ASSET_CODE'\) \?\? '[A-Z]/);
  });

  it('reads the issuer from the environment too, since a wrong one matches nothing', () => {
    const line = settingFor('USDC_ASSET_ISSUER');
    expect(line).toMatch(/\$\{USDC_ASSET_ISSUER/);
  });

  it('never pins an identity, a key or an endpoint to a literal', () => {
    const mustNotBeLiteral = [
      'ESCROW_CONTRACT_ID',
      'STAKING_CONTRACT_ID',
      'PLATFORM_WALLET',
      'STELLAR_NETWORK_PASSPHRASE',
      'STELLAR_RPC_URL',
      'HORIZON_URL',
      'ALERT_WEBHOOK_URL',
    ];
    for (const key of mustNotBeLiteral) {
      const line = settingFor(key);
      if (!line) continue;
      expect(line).toMatch(new RegExp(`\\$\\{${key}`));
    }
  });
});
