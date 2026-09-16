import { AdminService } from './admin.service';

const ADDR = 'GBSYTTNQVWKH2DOIWXSE6UVJXRCUIXKSC5TBPYWNLCXLS35FKH7DNOHT';

function build(lps: any[] = []) {
  const client: any = {
    lp: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn(async () => lps),
      create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })),
    },
    walletLink: { findUnique: jest.fn().mockResolvedValue(null) },
    kycVerification: { findMany: jest.fn(async () => []) },
    adminAudit: { create: jest.fn(async () => ({})) },
  };
  client.$transaction = jest.fn(async (cb: any) => cb(client));
  const stellar = { hasUsdcTrustline: jest.fn().mockResolvedValue(true) } as any;
  const cfg = { usdcAssetCode: 'TUSDC', usdcAssetIssuer: 'GISSUER' } as any;
  const userReputation = { personIdFor: jest.fn().mockResolvedValue('person-1') } as any;
  const svc = new AdminService(client, stellar, cfg, {} as any, userReputation, {} as any, {
    notifyOrderStatus: jest.fn(),
  } as any);
  return { svc, client };
}

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

describe('listing providers answers from the provider table alone', () => {
  const lpRows = [
    { id: 'lp-a', personId: 'person-1', status: 'PENDING' },
    { id: 'lp-b', personId: null, status: 'APPROVED' },
  ];

  it('returns every provider it was asked for', async () => {
    const { svc } = build(lpRows);

    const rows = await svc.list();

    expect(rows.map((r: any) => r.id)).toEqual(['lp-a', 'lp-b']);
  });

  it('asks nothing of the KYC table, because the list carries no verification column', async () => {
    const { svc, client } = build(lpRows);

    await svc.list();

    expect(client.kycVerification.findMany).not.toHaveBeenCalled();
  });

  it('puts no identityVerified key on a row, so nothing can read a gate this list does not apply', async () => {
    const { svc } = build(lpRows);

    const rows = await svc.list();

    for (const r of rows as any[]) expect(r).not.toHaveProperty('identityVerified');
    expect(rows).toHaveLength(2);
  });
});
