import { ConflictException } from '@nestjs/common';
import { LpService } from '../lp/lp.service';
import { AdminService } from './admin.service';
import { auditPayload } from './admin-audit';

const LP_ADDR = 'GLP00000000000000000000000000000000000000000000000000000';
const ADMIN_ADDR = 'GADMIN000000000000000000000000000000000000000000000000A';

function makePrisma(lpRow: any) {
  const audits: any[] = [];
  const tx = {
    lp: {
      findUnique: jest.fn().mockResolvedValue(lpRow),
      update: jest.fn().mockImplementation(async ({ data }: any) => ({ ...lpRow, ...data })),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'new-lp', ...data })),
    },
    adminAudit: { create: jest.fn().mockImplementation(async ({ data }: any) => { audits.push(data); return data; }) },
    config: {
      findUnique: jest.fn().mockResolvedValue({
        id: 1, platformFeeBps: 30, lpFeeBps: 120, minOrder: 1n, maxOrder: 9n,
        payWindowSecs: 1800, confirmWindowSecs: 1800, disputeWindowSecs: 7200,
      }),
      update: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 1, ...data })),
    },
  };
  const prisma: any = {
    ...tx,
    $transaction: jest.fn(async (cb: any) => cb(tx)),
  };
  return { prisma, tx, audits };
}

describe('LpService.apply — a provider must not be able to clear its own sanction', () => {
  function svc(lpRow: any) {
    const { prisma } = makePrisma(lpRow);
    const stellar = { stakingCooldownSecs: jest.fn().mockResolvedValue(349_201), hasUsdcTrustline: jest.fn().mockResolvedValue(true) } as any;
    return { service: new LpService(prisma, stellar), prisma };
  }

  it('refuses a re-application from a SUSPENDED provider', async () => {
    const { service, prisma } = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'SUSPENDED', approvalNote: 'took fiat, never delivered' });
    await expect(service.apply(LP_ADDR, 'x@y.z', 'proof')).rejects.toThrow(ConflictException);
    expect(prisma.lp.update).not.toHaveBeenCalled();
    expect(prisma.lp.create).not.toHaveBeenCalled();
  });

  it('refuses a re-application from a REVOKED provider — revocation is terminal', async () => {
    const { service } = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'REVOKED', approvalNote: 'fraud' });
    await expect(service.apply(LP_ADDR, 'x@y.z', 'proof')).rejects.toThrow(ConflictException);
  });

  it('never clears the administrator note on any re-application', async () => {
    const { service, prisma } = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'APPROVED', approvalNote: 'approved after review' });
    await service.apply(LP_ADDR, 'x@y.z', 'proof');
    const data = prisma.lp.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('approvalNote');
    expect(data.status).toBe('PENDING');
  });

  it('still accepts a first-time applicant', async () => {
    const { service, prisma } = svc(null);
    await service.apply(LP_ADDR, 'x@y.z', 'proof');
    expect(prisma.lp.create).toHaveBeenCalled();
  });
});

describe('LpService.me — the administrator note is internal', () => {
  it('does not return approvalNote to the provider', async () => {
    const { prisma } = makePrisma(null);
    prisma.lp.findUnique = jest.fn().mockResolvedValue({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'SUSPENDED' });
    const stellar = { stakingCooldownSecs: jest.fn().mockResolvedValue(349_201), hasUsdcTrustline: jest.fn() } as any;
    const service = new LpService(prisma, stellar);

    await service.me(LP_ADDR);

    const select = prisma.lp.findUnique.mock.calls[0][0].select;
    expect(select).toBeDefined();
    expect(select.approvalNote).toBeUndefined();
  });
});

describe('auditPayload', () => {
  it('renders BigInt fields as strings so the row is storable as JSON', () => {
    expect(auditPayload({ minOrder: 50000000n, name: 'x', nested: { max: 9n } })).toEqual({
      minOrder: '50000000',
      name: 'x',
      nested: { max: '9' },
    });
  });

  it('passes null and undefined through', () => {
    expect(auditPayload(null)).toBeNull();
    expect(auditPayload(undefined)).toBeNull();
  });

  it('renders dates as ISO strings', () => {
    expect(auditPayload({ at: new Date('2026-08-22T00:00:00Z') })).toEqual({
      at: '2026-08-22T00:00:00.000Z',
    });
  });
});

describe('AdminService — every mutation leaves a trail naming the actor', () => {
  function svc(lpRow: any) {
    const { prisma, tx, audits } = makePrisma(lpRow);
    const stellar = { stakingCooldownSecs: jest.fn().mockResolvedValue(349_201), hasUsdcTrustline: jest.fn().mockResolvedValue(true) } as any;
    const cfg = { usdcAssetCode: 'USDC', usdcAssetIssuer: 'GISSUER' } as any;
    const markets = { get: jest.fn(), update: jest.fn(), list: jest.fn() } as any;
    const userReputation = { getReputation: jest.fn() } as any;
    return {
      service: new AdminService(prisma, stellar, cfg, markets, userReputation),
      prisma,
      tx,
      audits,
    };
  }

  it('records a suspension with the actor, the target and the before/after status', async () => {
    const { service, audits } = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'APPROVED', approvedAt: null });

    await service.setStatus('lp-1', 'SUSPENDED', 'took fiat, never delivered', ADMIN_ADDR);

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorAddress: ADMIN_ADDR,
      action: 'lp.setStatus',
      targetType: 'Lp',
      targetId: 'lp-1',
    });
    expect(audits[0].before).toMatchObject({ status: 'APPROVED' });
    expect(audits[0].after).toMatchObject({ status: 'SUSPENDED' });
  });

  it('writes the audit row inside the same transaction as the change', async () => {
    const { service, prisma, tx } = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'APPROVED', approvedAt: null });
    await service.setStatus('lp-1', 'REVOKED', 'fraud', ADMIN_ADDR);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(tx.adminAudit.create).toHaveBeenCalled();
  });

  it('records an administrator registering a provider', async () => {
    const { service, audits } = svc(null);
    await service.register(
      { stellarAddress: 'GBEIUZUZ625KNMPNMKX7HSF2GPXZRD6CL7OUH7JD5CQQXNTTKLZNMSIA', contact: 'c' } as any,
      ADMIN_ADDR,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorAddress: ADMIN_ADDR, action: 'lp.register', targetType: 'Lp' });
  });

  it('records a config change with both sides, BigInt-safe', async () => {
    const { service, audits } = svc(null);
    await service.updateConfigTransactional({ platformFeeBps: 40 } as any, ADMIN_ADDR);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorAddress: ADMIN_ADDR, action: 'config.update', targetType: 'Config' });
    expect(typeof (audits[0].before as any).minOrder).toBe('string');
  });
});
