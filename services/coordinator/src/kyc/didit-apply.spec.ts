import { Sep12Service } from './sep12.service';

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
