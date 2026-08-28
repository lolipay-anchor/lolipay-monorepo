import { Sep12Service } from './sep12.service';

const REF = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const AT = new Date('2026-08-28T05:00:00.000Z');
const EARLIER = new Date('2026-08-28T04:00:00.000Z');

function svc(row: any, environment = 'sandbox') {
  const store = { row };
  const prisma = {
    kycVerification: {
      findUnique: jest.fn(async () => store.row),
      update: jest.fn(async ({ data }: any) => (store.row = { ...store.row, ...data })),
      create: jest.fn(async ({ data }: any) => (store.row = data)),
    },
  } as any;
  const people = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) } as any;
  const cfg = { diditEnvironment: environment } as any;
  return { s: new Sep12Service(prisma, people, {} as any, cfg), store, prisma, people };
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

  it('refuses to set a screening timestamp when the delivery came from another environment', async () => {
    const { s, store } = svc(null, 'live');
    await s.applyDelivery(accepted(), AT);
    expect(store.row.status).toBe('ACCEPTED');
    expect(store.row.screenedAt).toBeNull();
  });

  it('ignores a delivery older than the one already applied', async () => {
    const { s, store, prisma } = svc({
      customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1', deliveredAt: AT,
    });
    await s.applyDelivery(accepted({ status: 'PROCESSING', screened: false }), EARLIER);
    expect(store.row.status).toBe('ACCEPTED');
    expect(prisma.kycVerification.update).not.toHaveBeenCalled();
  });

  it('ignores a delivery about a different session than the one this row is following', async () => {
    const { s, store } = svc({
      customerRef: REF, status: 'ACCEPTED', providerRef: 'sess-1', deliveredAt: EARLIER,
    });
    await s.applyDelivery(accepted({ providerRef: 'sess-9', status: 'REJECTED' }), AT);
    expect(store.row.status).toBe('ACCEPTED');
  });

  it('never lifts a refusal, whatever a later delivery says', async () => {
    const { s, store } = svc({
      customerRef: REF, status: 'REJECTED', providerRef: 'sess-1', deliveredAt: EARLIER,
    });
    await s.applyDelivery(accepted(), AT);
    expect(store.row.status).toBe('REJECTED');
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
