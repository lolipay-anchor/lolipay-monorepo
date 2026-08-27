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
  const p = new StubKycProvider(false);

  it('accepts a customer who supplied every field the suite fixture carries', async () => {
    expect(await p.start(complete)).toEqual({
      status: 'ACCEPTED',
      screened: false,
      providerRef: 'stub',
    });
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

  it('never reports a screening it did not perform, on any path it can take', async () => {
    const paths: Record<string, string>[] = [
      complete,
      { first_name: 'Budi' },
      { ...complete, first_name: 'REJECT' },
      {},
    ];
    for (const fields of paths) {
      expect((await p.start(fields)).screened).toBe(false);
    }
  });

  it('reports screening only when an operator has said this stack may pretend to screen', async () => {
    const pretending = new StubKycProvider(true);
    const out = await pretending.start(complete);
    expect(out.screened).toBe(true);
    expect(out.providerRef).toBe('stub');
  });

  it('names itself on the record, so a pretended screening is never mistaken for a real one', async () => {
    for (const screens of [true, false]) {
      expect((await new StubKycProvider(screens).start(complete)).providerRef).toBe('stub');
    }
  });

  it('still refuses to pretend on a path it did not accept', async () => {
    const pretending = new StubKycProvider(true);
    expect((await pretending.start({ first_name: 'Budi' })).screened).toBe(false);
    expect((await pretending.start({ ...complete, first_name: 'REJECT' })).screened).toBe(false);
  });

  it.each(REQUIRED_KYC_FIELDS)('needs information when %s is absent', async (field) => {
    const { [field]: _dropped, ...without } = complete;
    expect((await p.start(without)).status).toBe('NEEDS_INFO');
  });

  it('reads REJECT however the caller spaced or cased it', async () => {
    expect((await p.start({ ...complete, first_name: '  reject ' })).status).toBe('REJECTED');
  });
});
