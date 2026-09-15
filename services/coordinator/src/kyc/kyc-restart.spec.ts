import { Sep12Service } from './sep12.service';
import { KYC_FIELD_DESCRIPTORS } from './kyc-provider';

const DAY = 24 * 60 * 60 * 1000;

const FIELDS = {
  first_name: 'Budi',
  last_name: 'Santoso',
  email_address: 'budi@example.com',
  id_type: 'id_card',
  id_country_code: 'IDN',
};

function accepted(over: Record<string, unknown> = {}) {
  return {
    customerRef: 'GABC',
    personId: 'p1',
    status: 'ACCEPTED',
    providerRef: 'session-1',
    verificationUrl: 'https://verify.didit.me/s/1',
    rejectionReason: null,
    deliveredAt: null,
    screenedAt: null,
    verifiedAt: new Date(Date.now() - 40 * DAY),
    updatedAt: new Date(Date.now() - 40 * DAY),
    ...over,
  };
}

function make(row: any) {
  const upserts: any[] = [];
  const prisma: any = {
    person: { update: jest.fn(async () => ({})) },
    kycVerification: {
      findUnique: jest.fn(async () => row),
      findFirst: jest.fn(async () => null),
      upsert: jest.fn(async (a: any) => (upserts.push(a), {})),
    },
    $executeRaw: jest.fn(async () => 0),
    $transaction: jest.fn(async (cb: any) => cb(prisma)),
  };
  const people = { lookupPerson: jest.fn(async () => ({ id: 'p1' })) } as any;
  const provider = {
    start: jest.fn(async () => ({ status: 'PROCESSING', providerRef: 'session-2', verificationUrl: 'https://verify.didit.me/s/2' })),
  } as any;
  const cfg = { kycRequireAml: false } as any;
  const refusals = { workflowPerformsAml: jest.fn(), providerFailed: jest.fn(), providerRecovered: jest.fn() } as any;
  return { svc: new Sep12Service(prisma, people, provider, cfg, refusals), provider, upserts };
}

describe('a person the anchor accepted but never heard back about can start their verification again', () => {
  it('is asked for their details rather than told to keep waiting, because PROCESSING promises a later answer and for this row no answer is ever coming', async () => {
    const { svc } = make(accepted());

    await expect(svc.get('GABC')).resolves.toEqual({
      id: 'GABC',
      status: 'NEEDS_INFO',
      fields: KYC_FIELD_DESCRIPTORS,
      message:
        'this verification did not complete, so no trade can be opened yet; submit your details again and a new one will be opened',
    });
  });

  it('says that to nobody else, because the other two answers that ask for details are given to people no verification was ever opened for, and the sentence would be asserting a thing that never existed', async () => {
    const neverOpened = await make(accepted({ status: 'NEEDS_INFO' })).svc.get('GABC');
    const noRowAtAll = await make(null).svc.get('GABC');

    expect(neverOpened).not.toHaveProperty('message');
    expect(noRowAtAll).not.toHaveProperty('message');
    expect(noRowAtAll).not.toHaveProperty('id');
  });

  it('re-submitting actually writes the new session, because a guard inside the transaction reads the same untouched row and would otherwise discard the session it just paid the vendor to open', async () => {
    const { svc, provider, upserts } = make(accepted());

    await svc.put('GABC', { ...FIELDS });

    expect(provider.start).toHaveBeenCalledTimes(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].update).toMatchObject({ status: 'PROCESSING', providerRef: 'session-2' });
  });

  it('still reports a fresh acceptance as PROCESSING and opens no session for it, which is the row the SEP-12 suite creates and reads back within seconds', async () => {
    const { svc, provider } = make(accepted({ verifiedAt: new Date(), updatedAt: new Date() }));

    await expect(svc.get('GABC')).resolves.toMatchObject({ status: 'PROCESSING' });
    await svc.put('GABC', { ...FIELDS });

    expect(provider.start).not.toHaveBeenCalled();
  });

  it('opens a new session for an expired PROCESSING row by the same path, so the restart the popup offers means one thing whether the session expired or the acceptance was never delivered', async () => {
    const { svc, provider, upserts } = make(accepted({ status: 'PROCESSING', verifiedAt: null }));

    await svc.put('GABC', { ...FIELDS });

    expect(provider.start).toHaveBeenCalledTimes(1);
    expect(upserts[0].update).toMatchObject({ status: 'PROCESSING', providerRef: 'session-2' });
  });

  it('records an incomplete resubmission against a stale acceptance instead of discarding it, so the one row the anchor is telling to send details is not also the one row that ignores them', async () => {
    const { svc, provider, upserts } = make(accepted());

    await svc.put('GABC', { first_name: 'Budi' });

    expect(provider.start).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].update).toMatchObject({ status: 'NEEDS_INFO', verifiedAt: null });
  });

  it('opens no session for an acceptance the provider did deliver, however long ago, so a settled customer is never sent round again', async () => {
    const { svc, provider } = make(accepted({ deliveredAt: new Date(Date.now() - 40 * DAY) }));

    await svc.put('GABC', { ...FIELDS });

    expect(provider.start).not.toHaveBeenCalled();
  });
});
