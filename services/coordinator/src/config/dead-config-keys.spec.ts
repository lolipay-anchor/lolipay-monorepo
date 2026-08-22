import { readFileSync } from 'fs';
import { join } from 'path';

const SET_THROUGH_THE_ADMIN_API = [
  'SPREAD_BPS',
  'PLATFORM_FEE_BPS',
  'LP_FEE_BPS',
  'MIN_ORDER_USDC_BASEUNITS',
  'MAX_ORDER_USDC_BASEUNITS',
];

describe('the environment template only names variables something reads', () => {
  const env = readFileSync(join(__dirname, '../../.env.example'), 'utf8');
  const appConfig = readFileSync(join(__dirname, 'app-config.service.ts'), 'utf8');

  it.each(SET_THROUGH_THE_ADMIN_API)(
    'does not offer %s, which lives in Config and moves through PATCH /admin/config',
    (key) => {
      expect(env).not.toMatch(new RegExp(`^${key}=`, 'm'));
    },
  );

  it('does not read a global price band, because the bounds are per market', () => {
    expect(appConfig).not.toContain('PRICE_MIN_IDR_PER_USDC');
    expect(appConfig).not.toContain('PRICE_MAX_IDR_PER_USDC');
  });

  it('still offers the variables that are genuinely read', () => {
    for (const key of ['PRICE_DEVIATION_MAX_BPS', 'PRICE_STALE_SECONDS', 'PLATFORM_WALLET']) {
      expect(env).toMatch(new RegExp(`^${key}=`, 'm'));
    }
  });
});
