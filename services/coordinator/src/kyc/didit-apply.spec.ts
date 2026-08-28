import { Sep12Service } from './sep12.service';
import { DiditRefusalsService } from '../monitoring/didit-refusals.service';

const REF = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const AT = new Date('2026-08-28T05:00:00.000Z');
const EARLIER = new Date('2026-08-28T04:00:00.000Z');

function svc(row: any, environment = 'sandbox', personRefusal: any = null) {
  const store = { row };
  const prisma: any = {
    kycVerification: {
      findUnique: jest.fn(async () => store.row),
      findFirst: jest.fn(async () => personRefusal),
      update: jest.fn(async ({ data }: any) => (store.row = { ...store.row, ...data })),
      create: jest.fn(async ({ data }: any) => (store.row = data)),
    },
  };
  prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
  prisma.$executeRaw = jest.fn().mockResolvedValue(0);
  const people = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) } as any;
  const cfg = { diditEnvironment: environment } as any;
  const refusals = { record: jest.fn(), applied: jest.fn(), state: jest.fn() } as any;
  return { s: new Sep12Service(prisma, people, {} as any, cfg, refusals), store, prisma, people, refusals };
}

const accepted = (over: Record<string, unknown> = {}) => ({
  status: 'ACCEPTED' as const,
  screened: true,
  environment: 'sandbox',
  providerRef: 'sess-1',
  customerRef: REF,
  ...over,
});

describe('applying what a delivery concluded', () => {
  it('records an accepted, screened customer against the person who owns the address', async () => {
    const { s, store } = svc(null);
    await s.applyDelivery(accepted(), AT);
    expect(store.row).toMatchObject({
      customerRef: REF,
      personId: 'person-1',
      status: 'ACCEPTED',
      providerRef: 'sess-1',
      environment: 'sandbox',
      screenedAt: AT,
      deliveredAt: AT,
    });
  });

  it('takes its timestamps from the delivery, so a retry writes exactly what the first attempt did', async () => {
    const { s, store } = svc(null);
    await s.applyDelivery(accepted(), AT);
    const first = { ...store.row };
    await s.applyDelivery(accepted(), AT);
    expect(store.row).toEqual(first);
  });

  it('ignores a delivery older than the one already applied', async () => {
    const { s, store, prisma } = svc({
      customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1', deliveredAt: AT,
    });
    await s.applyDelivery(accepted({ status: 'PROCESSING', screened: false }), EARLIER);
    expect(store.row.status).toBe('ACCEPTED');
    expect(prisma.kycVerification.update).not.toHaveBeenCalled();
  });

  it('ignores an approval from a session the row is not following, which a refusal is allowed to override', async () => {
    const { s, store } = svc({
      customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1', deliveredAt: EARLIER, screenedAt: EARLIER,
    });
    await s.applyDelivery(accepted({ providerRef: 'sess-9' }), AT);
    expect(store.row.providerRef).toBe('sess-1');
    expect(store.row.deliveredAt).toBe(EARLIER);
  });

  it('never lifts a refusal, whatever a later delivery says', async () => {
    const { s, store } = svc({
      customerRef: REF, status: 'REJECTED', providerRef: 'sess-1', deliveredAt: EARLIER,
    });
    await s.applyDelivery(accepted(), AT);
    expect(store.row.status).toBe('REJECTED');
  });

  it('applies a refusal that arrives after an approval it should have preceded', async () => {
    const { s, store } = svc({
      customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1', deliveredAt: AT, screenedAt: AT,
    });
    await s.applyDelivery(
      accepted({ status: 'REJECTED', screened: false, rejectionReason: 'sanctions or watchlist match' }),
      EARLIER,
    );
    expect(store.row.status).toBe('REJECTED');
    expect(store.row.screenedAt).toBeNull();
  });

  it('drops a delivery from an environment this deployment is not configured for, rather than half applying it', async () => {
    const { s, store, prisma } = svc(null, 'live');
    await s.applyDelivery(accepted(), AT);
    expect(store.row).toBeNull();
    expect(prisma.kycVerification.create).not.toHaveBeenCalled();
  });

  it('refuses to record an approval for a person who already stands refused elsewhere', async () => {
    const { s, prisma } = svc(null, 'sandbox', { customerRef: `${REF}:9`, status: 'REJECTED' });
    await s.applyDelivery(accepted(), AT);
    expect(prisma.kycVerification.create).not.toHaveBeenCalled();
  });

  it('reads and writes under one lock, so two deliveries cannot both act on a stale read', async () => {
    const { s, prisma } = svc(null);
    await s.applyDelivery(accepted(), AT);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('still follows a session pin when the standing row was accepted', async () => {
    const { s, store } = svc({
      customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1', deliveredAt: EARLIER,
    });
    await s.applyDelivery(accepted({ providerRef: 'sess-9', status: 'PROCESSING' }), AT);
    expect(store.row.status).toBe('ACCEPTED');
  });

  it('lets a fresh session update a customer who was only ever told they need information', async () => {
    const { s, store } = svc({
      customerRef: REF, status: 'NEEDS_INFO', providerRef: 'stub', deliveredAt: EARLIER,
    });
    await s.applyDelivery(accepted({ providerRef: 'sess-new' }), AT);
    expect(store.row.status).toBe('ACCEPTED');
    expect(store.row.providerRef).toBe('sess-new');
  });

  it('does not undo a verification on the strength of a status it did not understand', async () => {
    const { s, store } = svc({
      customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1',
      deliveredAt: EARLIER, screenedAt: EARLIER,
    });
    await s.applyDelivery(
      accepted({ status: 'PROCESSING', screened: false, unrecognisedStatus: 'Somethingnew' }),
      AT,
    );
    expect(store.row.status).toBe('ACCEPTED');
    expect(store.row.screenedAt).toBe(EARLIER);
  });

  it.each([
    ['a session the row never followed', 'sess-9'],
    ['no session at all, as ongoing monitoring sends', undefined],
  ])('applies a refusal arriving from %s, because a hit is not tied to a verification session', async (_n, ref) => {
    const { s, store } = svc({
      customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1', deliveredAt: AT, screenedAt: AT,
    });
    await s.applyDelivery(
      accepted({ status: 'REJECTED', screened: false, providerRef: ref, rejectionReason: 'sanctions or watchlist match' }),
      EARLIER,
    );
    expect(store.row.status).toBe('REJECTED');
    expect(store.row.screenedAt).toBeNull();
  });

  it('counts a delivery it drops, so a silent failure still reaches somebody', async () => {
    const { s, refusals } = svc(null, 'live');
    await s.applyDelivery(accepted(), AT);
    expect(refusals.record).toHaveBeenCalledWith(expect.stringContaining('environment'));
  });

  it('clears the count once a delivery is finally acted on', async () => {
    const { s, refusals } = svc(null);
    await s.applyDelivery(accepted(), AT);
    expect(refusals.applied).toHaveBeenCalled();
  });

  it('takes the lock on the person, because the rule it guards spans every address they own', async () => {
    const { s, prisma } = svc(null);
    await s.applyDelivery(accepted(), AT);
    const sql = prisma.$executeRaw.mock.calls[0];
    expect(JSON.stringify(sql)).toContain('person-1');
  });

  it('ignores a delivery that names no customer', async () => {
    const { s, prisma } = svc(null);
    await s.applyDelivery(accepted({ customerRef: undefined }), AT);
    expect(prisma.kycVerification.create).not.toHaveBeenCalled();
  });

  it('refuses to write a customer it cannot bind to a person', async () => {
    const { s, prisma, people } = svc(null);
    people.lookupPerson.mockResolvedValue(null);
    await s.applyDelivery(accepted(), AT);
    expect(prisma.kycVerification.create).not.toHaveBeenCalled();
  });

  it('leaves the screening timestamp empty when the screening never ran', async () => {
    const { s, store } = svc(null);
    await s.applyDelivery(accepted({ screened: false }), AT);
    expect(store.row.status).toBe('ACCEPTED');
    expect(store.row.screenedAt).toBeNull();
  });
});

describe('registering a customer does not spend on every attempt', () => {
  const complete = {
    first_name: 'Budi', last_name: 'Santoso', email_address: 'budi@example.com',
    id_type: 'id_card', id_country_code: 'IDN',
  };

  function putSvc(row: any) {
    const store = { row };
    const prisma: any = {
      kycVerification: {
        findUnique: jest.fn(async () => store.row),
        findFirst: jest.fn(async () => null),
        count: jest.fn(async () => 0),
        upsert: jest.fn(async ({ create, update }: any) =>
          (store.row = store.row ? { ...store.row, ...update } : create),
        ),
      },
      $executeRaw: jest.fn(async () => 0),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const people = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) } as any;
    const provider = { start: jest.fn(async () => ({ status: 'PROCESSING', providerRef: 'sess-new', verificationUrl: 'https://verify.didit.me/session/abc' })) } as any;
    const refusals = new DiditRefusalsService();
    const svc = new Sep12Service(prisma, people, provider, { diditEnvironment: 'sandbox' } as any, refusals);
    return { svc, provider, store, prisma };
  }

  it('does not open a session for a submission that is missing what the provider needs', async () => {
    const { svc, provider } = putSvc(null);
    await svc.put(REF, { first_name: 'Budi' });
    expect(provider.start).not.toHaveBeenCalled();
  });

  it('does not open a session for an empty submission', async () => {
    const { svc, provider } = putSvc(null);
    await svc.put(REF, {});
    expect(provider.start).not.toHaveBeenCalled();
  });

  it('reuses a session that is already in flight rather than buying another', async () => {
    const { svc, provider } = putSvc({
      customerRef: REF, status: 'PROCESSING', providerRef: 'sess-open',
    });
    const res = await svc.put(REF, complete);
    expect(provider.start).not.toHaveBeenCalled();
    expect(res).toEqual({ id: REF });
  });

  it('does not carry a previous screening across to a new registration', async () => {
    const { svc, store } = putSvc({
      customerRef: REF, status: 'REJECTED', providerRef: 'sess-old',
      screenedAt: new Date('2026-01-01'), deliveredAt: new Date('2026-01-01'),
      environment: 'live', rejectionReason: 'old',
    });
    store.row.status = 'NEEDS_INFO';
    await svc.put(REF, complete);
    expect(store.row.screenedAt).toBeNull();
    expect(store.row.deliveredAt).toBeNull();
    expect(store.row.environment).toBeNull();
  });

  it('keeps the link to where a customer must go to finish verifying', async () => {
    const { svc, store } = putSvc(null);
    await svc.put(REF, complete);
    expect(store.row.verificationUrl).toBe('https://verify.didit.me/session/abc');
  });

  it('cannot be made to erase its own screening record by submitting nothing', async () => {
    const screened = new Date('2026-02-02');
    const { svc, store } = putSvc({
      customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-done',
      screenedAt: screened, verifiedAt: screened, deliveredAt: screened, environment: 'sandbox',
    });
    await svc.put(REF, {});
    expect(store.row.screenedAt).toBe(screened);
    expect(store.row.deliveredAt).toBe(screened);
    expect(store.row.environment).toBe('sandbox');
    expect(store.row.status).toBe('ACCEPTED');
  });

  it('never buys a second session for a customer who is already verified', async () => {
    const screened = new Date('2026-02-02');
    const { svc, provider, store } = putSvc({
      customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-done',
      screenedAt: screened, verifiedAt: screened, environment: 'sandbox',
    });
    const res = await svc.put(REF, complete);
    expect(provider.start).not.toHaveBeenCalled();
    expect(store.row.status).toBe('ACCEPTED');
    expect(store.row.screenedAt).toBe(screened);
    expect(res).toEqual({ id: REF });
  });

  it('does not write when a refusal lands while the provider was being called', async () => {
    const { svc, store, prisma } = putSvc(null);
    prisma.kycVerification.findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ customerRef: REF, status: 'REJECTED', personId: 'person-1' });
    await svc.put(REF, complete);
    expect(store.row).toBeNull();
  });

  it('opens one when the submission is complete and nothing is in flight', async () => {
    const { svc, provider } = putSvc(null);
    await svc.put(REF, complete);
    expect(provider.start).toHaveBeenCalledWith(REF, complete);
  });
});

describe('two requests arriving together buy one session, not two', () => {
  const complete = {
    first_name: 'Budi', last_name: 'Santoso', email_address: 'budi@example.com',
    id_type: 'id_card', id_country_code: 'IDN',
  };

  it('opens a single verification when the same customer asks twice at once', async () => {
    const store: any = { row: null };
    const prisma: any = {
      kycVerification: {
        findUnique: jest.fn(async () => store.row),
        findFirst: jest.fn(async () => null),
        count: jest.fn(async () => 0),
        upsert: jest.fn(async ({ create, update }: any) =>
          (store.row = store.row ? { ...store.row, ...update } : create),
        ),
      },
      $executeRaw: jest.fn(async () => 0),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const people = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) } as any;
    const start = jest.fn(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ status: 'PROCESSING', providerRef: 'sess-1' }), 20),
        ),
    );
    const refusals = new DiditRefusalsService();
    const svc = new Sep12Service(
      prisma, people, { start } as any, { diditEnvironment: 'sandbox' } as any, refusals,
    );

    await Promise.all([svc.put(REF, complete), svc.put(REF, complete)]);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('the refusal counter survives a delivery that did not commit', () => {
  it('does not clear itself when the write rolls back', async () => {
    const refusals = new DiditRefusalsService();
    refusals.record('an earlier delivery this anchor could not act on');
    const prisma: any = {
      $executeRaw: jest.fn(async () => 0),
      $transaction: jest.fn(async () => {
        throw new Error('the write did not commit');
      }),
    };
    const people = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) } as any;
    const svc = new Sep12Service(
      prisma, people, {} as any, { diditEnvironment: 'sandbox' } as any, refusals,
    );
    await expect(
      svc.applyDelivery(
        { customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1', screened: true, environment: 'sandbox' } as any,
        new Date(),
      ),
    ).rejects.toThrow();
    expect(refusals.state().count).toBe(1);
  });

  it('records a delivery naming somebody this anchor cannot resolve, rather than dropping it in silence', async () => {
    const refusals = new DiditRefusalsService();
    const people = { lookupPerson: jest.fn(async () => null) } as any;
    const svc = new Sep12Service(
      {} as any, people, {} as any, { diditEnvironment: 'sandbox' } as any, refusals,
    );
    await svc.applyDelivery(
      { customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1', screened: true, environment: 'sandbox' } as any,
      new Date(),
    );
    expect(refusals.state().count).toBe(1);
    expect(String(refusals.state().lastReason)).toMatch(/revoked link|misdirected/);
  });
});
