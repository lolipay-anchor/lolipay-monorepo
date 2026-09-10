import { Sep12Service } from './sep12.service';
import { DiditRefusalsService } from '../monitoring/didit-refusals.service';

const REF = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const AT = new Date('2026-08-28T05:00:00.000Z');
const EARLIER = new Date('2026-08-28T04:00:00.000Z');

function svc(row: any, environment = 'sandbox', personRefusal: any = null) {
  const store = { row };
  const prisma: any = {
    person: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
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
  const refusals = new DiditRefusalsService();
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
    expect(refusals.state().count).toBe(1);
    expect(String(refusals.state().lastReason)).toContain('environment');
  });

  it('clears the count once a delivery is finally acted on', async () => {
    const { s, refusals } = svc(null);
    refusals.record('an earlier delivery this anchor could not act on');
    await s.applyDelivery(accepted(), AT);
    expect(refusals.state().count).toBe(0);
  });

  it('takes the lock on the person, because the rule it guards spans every address they own', async () => {
    const { s, prisma } = svc(null);
    await s.applyDelivery(accepted(), AT);
    const sql = prisma.$executeRaw.mock.calls[0];
    expect(JSON.stringify(sql)).toContain('person-1');
  });

  it('takes it in the same lock space the rest of the anchor uses for a person, or it excludes nothing', async () => {
    const { s, prisma } = svc(null);
    await s.applyDelivery(accepted(), AT);
    const text = prisma.$executeRaw.mock.calls[0][0].join('?');
    expect(text).toContain('pg_advisory_xact_lock(hashtext(');
    expect(text).not.toMatch(/pg_advisory_xact_lock\(\s*\?/);
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

  it('drops a late approval for a session the customer has already left, because the row now follows the session opened afterwards, and counts it apart from a refusal', async () => {
    const { s, store, prisma, refusals } = svc({
      customerRef: REF, status: 'PROCESSING', providerRef: 'sess-2', deliveredAt: null, screenedAt: null,
    });
    await s.applyDelivery(accepted({ providerRef: 'sess-1' }), AT);
    expect(store.row.status).toBe('PROCESSING');
    expect(store.row.providerRef).toBe('sess-2');
    expect(prisma.kycVerification.update).not.toHaveBeenCalled();
    expect(refusals.state()).toMatchObject({ count: 0, outOfSession: 1, outOfSessionReason: expect.stringMatching(/not following/) });
  });

  it('still lets a refusal land whatever session it names, because a refusal follows the person', async () => {
    const { s, store } = svc({
      customerRef: REF, status: 'PROCESSING', providerRef: 'sess-2', deliveredAt: null, screenedAt: null,
    });
    await s.applyDelivery(accepted({ providerRef: 'sess-1', status: 'REJECTED', screened: false, rejectionReason: 'sanctions or watchlist match' }), AT);
    expect(store.row.status).toBe('REJECTED');
  });

  it('follows the session it opened for the delivery that moves the row forward', async () => {
    const { s, store } = svc({
      customerRef: REF, status: 'PROCESSING', providerRef: 'sess-2', deliveredAt: null, screenedAt: null,
    });
    await s.applyDelivery(accepted({ providerRef: 'sess-2' }), AT);
    expect(store.row.status).toBe('ACCEPTED');
    expect(store.row.providerRef).toBe('sess-2');
  });

  it('counts a delivery for a session an accepted row is not following apart from a refusal too', async () => {
    const { s, refusals } = svc({
      customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1', deliveredAt: EARLIER, screenedAt: EARLIER,
    });
    await s.applyDelivery(accepted({ providerRef: 'sess-9' }), AT);
    expect(refusals.state()).toMatchObject({ count: 0, outOfSession: 1 });
  });

  it('drops even a screened approval for the session the customer left, so the live session can still lower the row afterwards', async () => {
    const reopenedAt = new Date('2026-08-28T04:30:00.000Z');
    const { s, store, refusals } = svc({
      customerRef: REF, status: 'PROCESSING', providerRef: 'sess-2', deliveredAt: null, screenedAt: null, updatedAt: reopenedAt,
    });
    await s.applyDelivery(accepted({ providerRef: 'sess-1', screened: true }), AT);
    expect(store.row.status).toBe('PROCESSING');
    expect(store.row.providerRef).toBe('sess-2');
    expect(refusals.state().outOfSession).toBe(1);
    await s.applyDelivery(
      accepted({ providerRef: 'sess-2', status: 'NEEDS_INFO', screened: false, rejectionReason: 'the screening could not be read' }),
      new Date('2026-08-28T05:10:00.000Z'),
    );
    expect(store.row.status).toBe('NEEDS_INFO');
    expect(store.row.providerRef).toBe('sess-2');
    expect(refusals.state().outOfSession).toBe(1);
  });

  it('never lets an approval from another session overwrite a row that is already accepted', async () => {
    const { s, store, refusals } = svc({
      customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1', deliveredAt: EARLIER, screenedAt: EARLIER, updatedAt: EARLIER,
    });
    await s.applyDelivery(accepted({ providerRef: 'sess-9', screened: false }), AT);
    expect(store.row.screenedAt).toBe(EARLIER);
    expect(store.row.providerRef).toBe('sess-1');
    expect(refusals.state().outOfSession).toBe(1);
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
      person: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
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

  it('refuses an incomplete submission that races a refusal, instead of writing NEEDS_INFO over the refusal that landed between the check and the write', async () => {
    const { svc, prisma, store } = putSvc({ customerRef: REF, status: 'NEEDS_INFO', providerRef: null });
    prisma.kycVerification.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ customerRef: REF, status: 'REJECTED', rejectionReason: 'sanctions or watchlist match' });
    await expect(svc.put(REF, { first_name: 'Budi' })).rejects.toThrow(/refused/);
    expect(prisma.kycVerification.upsert).not.toHaveBeenCalled();
    expect(store.row.status).toBe('NEEDS_INFO');
  });

  it('leaves an acceptance that landed between the check and the write untouched, instead of demoting a customer the provider just accepted', async () => {
    const { svc, prisma, store } = putSvc(null);
    const accepted = { customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1', screenedAt: new Date('2026-09-05'), deliveredAt: new Date('2026-09-05') };
    prisma.kycVerification.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(accepted);
    const res = await svc.put(REF, { first_name: 'Budi' });
    expect(res).toEqual({ id: REF });
    expect(prisma.kycVerification.upsert).not.toHaveBeenCalled();
    expect(store.row).toBeNull();
  });

  it('writes an incomplete submission under the person lock the delivery path takes', async () => {
    const { svc, prisma } = putSvc(null);
    await svc.put(REF, { first_name: 'Budi' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const lock = prisma.$executeRaw.mock.calls[0];
    expect(lock[0].join('?')).toContain('pg_advisory_xact_lock(hashtext(');
    expect(lock[1]).toBe('person-1');
    expect(prisma.kycVerification.upsert).toHaveBeenCalledTimes(1);
  });

  it('opens a new session for a customer whose in-flight session is older than a day, so a row pinned to a session the vendor never finished is not a dead end', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const { svc, provider, store } = putSvc({
      customerRef: REF, status: 'PROCESSING', providerRef: 'sess-stale', updatedAt: twoDaysAgo,
    });
    await svc.put(REF, complete);
    expect(provider.start).toHaveBeenCalledTimes(1);
    expect(store.row.providerRef).toBe('sess-new');
  });

  it('keeps reusing an in-flight session that is younger than a day', async () => {
    const { svc, provider } = putSvc({
      customerRef: REF, status: 'PROCESSING', providerRef: 'sess-open', updatedAt: new Date(),
    });
    await svc.put(REF, complete);
    expect(provider.start).not.toHaveBeenCalled();
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
      person: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
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

describe('forgetting a customer reaches every refusal that person carries, and nothing else', () => {
  function forgetSvc(own: any, refusals: any[], person: any = { id: 'person-1' }) {
    const updates: any[] = [];
    const tx: any = {
      $executeRaw: jest.fn(async () => 0),
      person: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
      kycVerification: {
        findMany: jest.fn(async () => refusals),
        updateMany: jest.fn(async (args: any) => {
          updates.push(args);
          return { count: refusals.length };
        }),
      },
    };
    const prisma: any = {
      person: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
      kycVerification: {
        findUnique: jest.fn(async () => own),
        deleteMany: jest.fn(async () => ({ count: own && own.status !== 'REJECTED' ? 1 : 0 })),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const people = { lookupPerson: jest.fn(async () => person) } as any;
    const svc = new Sep12Service(
      prisma, people, {} as any, { diditEnvironment: 'sandbox' } as any,
      new DiditRefusalsService(),
    );
    return { svc, updates, tx };
  }

  it('redacts every wallet this person was refused under, not whichever row came back first', async () => {
    const { svc, updates } = forgetSvc(null, [
      { customerRef: 'GONE' },
      { customerRef: 'GTWO' },
    ]);
    expect(await svc.forget(REF)).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].where.customerRef.in.sort()).toEqual(['GONE', 'GTWO']);
  });

  it('never lifts the refusal itself, only the words describing it', async () => {
    const { svc, updates } = forgetSvc(null, [{ customerRef: 'GONE' }]);
    await svc.forget(REF);
    expect(Object.keys(updates[0].data).sort()).toEqual(
      ['environment', 'providerRef', 'rejectionReason', 'screenedAt', 'verificationUrl', 'verifiedAt'],
    );
    expect(updates[0].data).not.toHaveProperty('status');
    expect(updates[0].data).not.toHaveProperty('personId');
  });

  it('takes the person lock, because the refusals it redacts span every wallet they own', async () => {
    const { svc, tx } = forgetSvc(null, [{ customerRef: 'GONE' }]);
    await svc.forget(REF);
    const text = tx.$executeRaw.mock.calls[0][0].join('?');
    expect(text).toContain('pg_advisory_xact_lock(hashtext(');
  });

  it('reports holding nothing only when this person really carries no refusal', async () => {
    const { svc, updates } = forgetSvc(null, []);
    expect(await svc.forget(REF)).toBe(0);
    expect(updates).toHaveLength(0);
  });
});

describe('a session bought while the customer was being settled elsewhere is discarded, not written', () => {
  const complete = {
    first_name: 'Budi', last_name: 'Santoso', email_address: 'budi@example.com',
    id_type: 'id_card', id_country_code: 'IDN',
  };

  it('never demotes a customer a delivery accepted while the vendor was answering', async () => {
    const screened = new Date('2026-04-04');
    const store: any = {
      row: { customerRef: REF, status: 'NEEDS_INFO', personId: 'person-1' },
    };
    const tx: any = {
      $executeRaw: jest.fn(async () => 0),
      person: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
      kycVerification: {
        findUnique: jest.fn(async () => store.row),
        findFirst: jest.fn(async () => null),
        upsert: jest.fn(async ({ update }: any) => (store.row = { ...store.row, ...update })),
      },
    };
    const prisma: any = {
      person: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
      kycVerification: {
        findUnique: jest.fn(async () => store.row),
        findFirst: jest.fn(async () => null),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const people = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) } as any;
    const provider = {
      start: jest.fn(async () => {
        store.row = {
          customerRef: REF, personId: 'person-1', status: 'ACCEPTED',
          providerRef: 'sess-webhook', screenedAt: screened, environment: 'sandbox',
        };
        return { status: 'PROCESSING', providerRef: 'sess-new' };
      }),
    } as any;
    const svc = new Sep12Service(
      prisma, people, provider, { diditEnvironment: 'sandbox' } as any,
      new DiditRefusalsService(),
    );

    await svc.put(REF, complete);
    expect(store.row.status).toBe('ACCEPTED');
    expect(store.row.screenedAt).toBe(screened);
    expect(store.row.providerRef).toBe('sess-webhook');
    expect(tx.kycVerification.upsert).not.toHaveBeenCalled();
  });
});

describe('the guards this anchor relies on are the ones it actually takes', () => {
  const complete = {
    first_name: 'Budi', last_name: 'Santoso', email_address: 'budi@example.com',
    id_type: 'id_card', id_country_code: 'IDN',
  };

  function harness(row: any) {
    const store = { row };
    const prisma: any = {
      person: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 0 })) },
      kycVerification: {
        findUnique: jest.fn(async () => store.row),
        findFirst: jest.fn(async () => null),
        upsert: jest.fn(async ({ create, update }: any) =>
          (store.row = store.row ? { ...store.row, ...update } : create),
        ),
      },
      $executeRaw: jest.fn(async () => 0),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const people = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) } as any;
    const provider = {
      start: jest.fn(async () => ({ status: 'PROCESSING', providerRef: 'sess-new' })),
    } as any;
    const svc = new Sep12Service(
      prisma, people, provider, { diditEnvironment: 'sandbox' } as any,
      new DiditRefusalsService(),
    );
    return { svc, prisma, store, provider };
  }

  it('buys a session under the same lock the delivery path takes, or the two do not exclude each other', async () => {
    const { svc, prisma } = harness(null);
    await svc.put(REF, complete);
    const text = prisma.$executeRaw.mock.calls[0][0].join('?');
    expect(text).toContain('pg_advisory_xact_lock(hashtext(');
    expect(text).not.toMatch(/pg_advisory_xact_lock\(\s*\?/);
  });

  it('keeps the provenance of a delivery already received when a later submission arrives incomplete', async () => {
    const delivered = new Date('2026-05-05');
    const { svc, store } = harness({
      customerRef: REF, personId: 'person-1', status: 'NEEDS_INFO',
      deliveredAt: delivered, environment: 'sandbox', providerRef: 'sess-old',
    });
    await svc.put(REF, {});
    expect(store.row.deliveredAt).toBe(delivered);
    expect(store.row.environment).toBe('sandbox');
  });

  it('holds the concurrency guard until the row exists, not merely until the vendor answers', async () => {
    const { svc, provider, prisma } = harness(null);
    let insideTransaction: Promise<any> | null = null;
    prisma.$transaction = jest.fn(async (fn: any) => {
      insideTransaction = svc.put(REF, complete);
      await new Promise((r) => setTimeout(r, 5));
      return fn(prisma);
    });
    await svc.put(REF, complete);
    await insideTransaction;
    expect(provider.start).toHaveBeenCalledTimes(1);
  });
});

describe('a Not Started delivery keeps the door to the vendor open', () => {
  it('records the session without a delivery time, so the popup keeps offering the vendor', async () => {
    const { s, store } = svc(null);
    await s.applyDelivery(accepted({ status: 'PROCESSING', screened: false, notStarted: true }), AT);
    expect(store.row).toMatchObject({ status: 'PROCESSING', providerRef: 'sess-1', deliveredAt: null, screenedAt: null });
  });

  it('stamps the delivery time once the person is inside the session', async () => {
    const { s, store } = svc({ customerRef: REF, status: 'PROCESSING', providerRef: 'sess-1', deliveredAt: null, screenedAt: null });
    await s.applyDelivery(accepted({ status: 'PROCESSING', screened: false }), AT);
    expect(store.row.deliveredAt).toEqual(AT);
  });

  it('never moves a delivery time backwards for a Not Started that arrives after progress', async () => {
    const { s, store } = svc({ customerRef: REF, status: 'PROCESSING', providerRef: 'sess-1', deliveredAt: EARLIER, screenedAt: null });
    await s.applyDelivery(accepted({ status: 'PROCESSING', screened: false, notStarted: true }), AT);
    expect(store.row.deliveredAt).toEqual(EARLIER);
  });
});
