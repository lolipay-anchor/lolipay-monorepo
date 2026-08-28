import { readFileSync } from 'fs';
import path from 'path';
import { StubKycProvider } from '../kyc/stub-kyc-provider';

const complete = {
  first_name: 'Budi',
  last_name: 'Santoso',
  email_address: 'budi@example.com',
  id_type: 'id_card',
  id_country_code: 'IDN',
};

describe('no configuration can make this anchor report a screening it did not perform', () => {
  it('offers no way for the stub to say a screening happened', async () => {
    const decision = await new StubKycProvider().start('GABC', complete);
    expect(Object.keys(decision)).not.toContain('screened');
    expect(JSON.stringify(decision)).not.toContain('screen');
  });

  it('leaves the screening timestamp to the delivery handler alone', () => {
    const service = readFileSync(path.resolve(__dirname, '../kyc/sep12.service.ts'), 'utf8');
    const writers = service
      .split('\n')
      .filter((l) => l.includes('screenedAt:') && !l.includes('screenedAt: null'));
    expect(writers).toHaveLength(1);
    expect(writers[0]).toContain('deliveredAt');
  });

  it('no longer offers an environment variable that could turn pretending on', () => {
    const template = readFileSync(path.resolve(__dirname, '../../.env.example'), 'utf8');
    expect(template).not.toMatch(/KYC_STUB_SCREENS/);
    const config = readFileSync(path.resolve(__dirname, 'app-config.service.ts'), 'utf8');
    expect(config).not.toMatch(/kycStubScreens/i);
  });
});
