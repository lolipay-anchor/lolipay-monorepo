import { StubKycProvider } from './stub-kyc-provider';

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
    expect(await p.start(complete)).toEqual({ status: 'ACCEPTED', screened: true });
  });

  it('leaves a customer needing information when a required field is missing', async () => {
    expect(await p.start({ first_name: 'Budi' })).toEqual({ status: 'NEEDS_INFO', screened: false });
  });

  it('needs information when a required field is present but blank', async () => {
    expect((await p.start({ ...complete, last_name: '   ' })).status).toBe('NEEDS_INFO');
  });

  it('rejects a name the operator has marked, so the rejected path is reachable in a test', async () => {
    const out = await p.start({ ...complete, first_name: 'REJECT' });
    expect(out.status).toBe('REJECTED');
    expect(out.rejectionReason).toBeDefined();
  });

  it('never reports a screening it did not perform', async () => {
    for (const fields of [{ first_name: 'Budi' }, { ...complete, first_name: 'REJECT' }]) {
      expect((await p.start(fields)).screened).toBe(false);
    }
  });
});
