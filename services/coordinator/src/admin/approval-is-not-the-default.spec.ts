import { AdminService } from './admin.service';

const ADDR = 'GBSYTTNQVWKH2DOIWXSE6UVJXRCUIXKSC5TBPYWNLCXLS35FKH7DNOHT';

type Kyc = { personId: string; status: string; screenedAt: Date | null; deliveredAt: Date | null };

function matchesKyc(r: Kyc, where: any): boolean {
  if (where.personId?.in !== undefined && !where.personId.in.includes(r.personId)) return false;
  if (where.status !== undefined && r.status !== where.status) return false;
  if (where.screenedAt?.not === null && r.screenedAt == null) return false;
  if (where.deliveredAt?.not === null && r.deliveredAt == null) return false;
  return true;
}

function build(lps: any[] = [], kycRows: Kyc[] = [], kycRequireAml = true) {
  const client: any = {
    lp: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn(async () => lps),
      create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })),
    },
    walletLink: { findUnique: jest.fn().mockResolvedValue(null) },
    kycVerification: {
      findMany: jest.fn(async ({ where }: any) => kycRows.filter((r) => matchesKyc(r, where))),
    },
    adminAudit: { create: jest.fn(async () => ({})) },
  };
  client.$transaction = jest.fn(async (cb: any) => cb(client));
  const stellar = { hasUsdcTrustline: jest.fn().mockResolvedValue(true) } as any;
  const cfg = { usdcAssetCode: 'TUSDC', usdcAssetIssuer: 'GISSUER', kycRequireAml } as any;
  const userReputation = { personIdFor: jest.fn().mockResolvedValue('person-1') } as any;
  const svc = new AdminService(client, stellar, cfg, {} as any, userReputation, {} as any, {
    notifyOrderStatus: jest.fn(),
  } as any);
  return { svc, client };
}

const verifiedFlag = (rows: unknown, id: string) =>
  (rows as { id: string; identityVerified?: boolean }[]).find((r) => r.id === id)!.identityVerified;

describe('registering a provider does not approve them unless the administrator says so', () => {
  it('leaves a registration that says nothing about approval PENDING, so approval is never reached by omission', async () => {
    const { svc } = build();

    const lp = await svc.register({ stellarAddress: ADDR, contact: 'tg:@lp' } as any, 'GADMINTEST');

    expect(lp.status).toBe('PENDING');
    expect(lp.approvedAt).toBeNull();
  });

  it('approves only when the administrator explicitly asks for it', async () => {
    const { svc } = build();

    const lp = await svc.register(
      { stellarAddress: ADDR, contact: 'tg:@lp', approve: true } as any,
      'GADMINTEST',
    );

    expect(lp.status).toBe('APPROVED');
    expect(lp.approvedAt).toBeInstanceOf(Date);
  });

  it('still leaves an explicit refusal PENDING', async () => {
    const { svc } = build();

    const lp = await svc.register(
      { stellarAddress: ADDR, contact: 'tg:@lp', approve: false } as any,
      'GADMINTEST',
    );

    expect(lp.status).toBe('PENDING');
    expect(lp.approvedAt).toBeNull();
  });
});

describe('the approver can see whether a provider has ever proved who they are', () => {
  const lpRows = [
    { id: 'lp-verified', personId: 'person-1', status: 'PENDING' },
    { id: 'lp-unverified', personId: 'person-2', status: 'PENDING' },
    { id: 'lp-no-person', personId: null, status: 'PENDING' },
    { id: 'lp-refused', personId: 'person-3', status: 'PENDING' },
  ];
  const kycRows: Kyc[] = [
    { personId: 'person-1', status: 'ACCEPTED', screenedAt: new Date(), deliveredAt: new Date() },
    { personId: 'person-3', status: 'ACCEPTED', screenedAt: new Date(), deliveredAt: new Date() },
    { personId: 'person-3', status: 'REJECTED', screenedAt: null, deliveredAt: null },
  ];

  it('marks a provider whose person holds a settled acceptance', async () => {
    const { svc } = build(lpRows, kycRows);

    const rows = await svc.list();

    expect(rows).toHaveLength(4);
    expect(verifiedFlag(rows, 'lp-verified')).toBe(true);
  });

  it.each([
    ['lp-unverified', 'holds no acceptance at all'],
    ['lp-no-person', 'has no linked person'],
    ['lp-refused', 'holds a refusal beside the acceptance'],
  ])('leaves %s unmarked, because it %s', async (id) => {
    const { svc } = build(lpRows, kycRows);

    const rows = await svc.list();

    expect(verifiedFlag(rows, id)).toBe(false);
  });

  it('asks for the acceptance the funds predicate requires, not a bare ACCEPTED', async () => {
    const { svc, client } = build(lpRows, kycRows);

    await svc.list();

    expect(client.kycVerification.findMany.mock.calls[0][0].where).toEqual({
      personId: { in: ['person-1', 'person-2', 'person-3'] },
      status: 'ACCEPTED',
      screenedAt: { not: null },
    });
  });

  it('reports nothing as verified when AML is required and no screening ever landed', async () => {
    const unscreened: Kyc[] = [
      { personId: 'person-1', status: 'ACCEPTED', screenedAt: null, deliveredAt: new Date() },
    ];
    const { svc } = build(lpRows, unscreened, true);

    const rows = await svc.list();

    expect(verifiedFlag(rows, 'lp-verified')).toBe(false);
  });

  it('accepts a delivered acceptance when AML is not required, which is the other half of the same predicate', async () => {
    const unscreened: Kyc[] = [
      { personId: 'person-1', status: 'ACCEPTED', screenedAt: null, deliveredAt: new Date() },
    ];
    const { svc } = build(lpRows, unscreened, false);

    const rows = await svc.list();

    expect(verifiedFlag(rows, 'lp-verified')).toBe(true);
  });

  it('asks nothing of the KYC table when no provider has a person', async () => {
    const { svc, client } = build([{ id: 'lp-no-person', personId: null, status: 'PENDING' }], []);

    const rows = await svc.list();

    expect(rows).toHaveLength(1);
    expect(client.kycVerification.findMany).not.toHaveBeenCalled();
  });
});
