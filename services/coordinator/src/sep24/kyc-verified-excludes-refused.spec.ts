import 'reflect-metadata';
import { Sep24Service } from './sep24.service';

const stamped = new Date('2026-09-04T00:00:00Z');

const rows = [
  { personId: 'p-clean', status: 'ACCEPTED', screenedAt: stamped, deliveredAt: stamped },
  { personId: 'p-refused', status: 'ACCEPTED', screenedAt: stamped, deliveredAt: stamped },
  { personId: 'p-refused', status: 'REJECTED', screenedAt: null, deliveredAt: stamped },
  { personId: 'p-stub', status: 'ACCEPTED', screenedAt: null, deliveredAt: null },
  { personId: 'p-delivered', status: 'ACCEPTED', screenedAt: null, deliveredAt: stamped },
  { personId: 'p-other', status: 'ACCEPTED', screenedAt: stamped, deliveredAt: stamped },
];

function matches(row: any, clause: any): boolean {
  if (clause.status !== undefined && row.status !== clause.status) return false;
  if (clause.screenedAt?.not === null && row.screenedAt == null) return false;
  if (clause.deliveredAt?.not === null && row.deliveredAt == null) return false;
  return true;
}

function service(kycRequireAml: boolean) {
  const prisma = {
    kycVerification: {
      findMany: jest.fn(async (args: any) => {
        const ids: string[] = args.where.personId.in;
        return rows
          .filter((r) => ids.includes(r.personId))
          .filter((r) => args.where.OR.some((alt: any) => matches(r, alt)))
          .map((r) => Object.fromEntries(Object.keys(args.select).map((k) => [k, (r as any)[k]])));
      }),
    },
  } as any;
  const cfg = { kycRequireAml } as any;
  const svc = new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { isConfigured: false } as any);
  return { svc, prisma };
}

const everyone = ['p-clean', 'p-refused', 'p-stub', 'p-delivered', 'p-unknown'];

describe('kyc_verified on a SEP-24 transaction record', () => {
  it('is true only for a person whose acceptance the gate honours and who carries no refusal under any subject', async () => {
    const { svc } = service(true);
    const verified = await (svc as any).screenedPeople(everyone);
    expect([...verified].sort()).toEqual(['p-clean']);
  });

  it('honours a delivered, unscreened acceptance when AML is optional, and still refuses a stub acceptance and a refused person', async () => {
    const { svc } = service(false);
    const verified = await (svc as any).screenedPeople(everyone);
    expect([...verified].sort()).toEqual(['p-clean', 'p-delivered']);
  });

  it('asks the database nothing for an empty list', async () => {
    const { svc, prisma } = service(true);
    expect(await (svc as any).screenedPeople([])).toEqual(new Set());
    expect(prisma.kycVerification.findMany).not.toHaveBeenCalled();
  });
});
