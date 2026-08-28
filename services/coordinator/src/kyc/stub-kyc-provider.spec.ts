import { StubKycProvider } from './stub-kyc-provider';
import { REQUIRED_KYC_FIELDS } from './kyc-provider';

const complete = {
  first_name: 'Budi',
  last_name: 'Santoso',
  email_address: 'b@example.com',
  id_type: 'id_card',
  id_country_code: 'IDN',
};

describe('the stub stands in for a provider that cannot be reached yet', () => {
  const p = new StubKycProvider();

  it('accepts a customer who supplied every field the suite fixture carries', async () => {
    expect(await p.start('GABC', complete)).toEqual({ status: 'ACCEPTED', providerRef: 'stub' });
  });

  it('leaves a customer needing information when a required field is missing', async () => {
    expect(await p.start('GABC', { first_name: 'Budi' })).toEqual({ status: 'NEEDS_INFO', providerRef: 'stub' });
  });

  it('needs information when a required field is present but blank', async () => {
    expect((await p.start('GABC', { ...complete, last_name: '   ' })).status).toBe('NEEDS_INFO');
  });

  it('rejects a name the operator has marked, so the rejected path is reachable in a test', async () => {
    const out = await p.start('GABC', { ...complete, first_name: 'REJECT' });
    expect(out.status).toBe('REJECTED');
    expect(out.rejectionReason).toBeDefined();
  });





  it.each(REQUIRED_KYC_FIELDS)('needs information when %s is absent', async (field) => {
    const { [field]: _dropped, ...without } = complete;
    expect((await p.start('GABC', without)).status).toBe('NEEDS_INFO');
  });

  it('reads REJECT however the caller spaced or cased it', async () => {
    expect((await p.start('GABC', { ...complete, first_name: '  reject ' })).status).toBe('REJECTED');
  });
});
