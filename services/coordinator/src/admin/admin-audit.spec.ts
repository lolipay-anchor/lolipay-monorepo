import { ConflictException } from '@nestjs/common';
import { LpService } from '../lp/lp.service';
import { AdminService } from './admin.service';
import { auditPayload } from './admin-audit';
import { Prisma } from '../generated/prisma/client';

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
        id: 1, spreadBps: 150, platformFeeBps: 30, lpFeeBps: 120, minOrder: 1n, maxOrder: 9n,
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
    const stellar = { stakingCooldownSecs: jest.fn().mockResolvedValue(349_201), hasUsdcTrustline: jest.fn().mockResolvedValue(true), readEscrowPlatformDefaults: jest.fn(async () => ({ platformFeeBps: 40, platformWallet: 'GBSYTTNQVWKH2DOIWXSE6UVJXRCUIXKSC5TBPYWNLCXLS35FKH7DNOHT' })) } as any;
    const cfg = { usdcAssetCode: 'USDC', usdcAssetIssuer: 'GISSUER' } as any;
    const markets = { get: jest.fn(), update: jest.fn(), list: jest.fn() } as any;
    const userReputation = { getReputation: jest.fn() } as any;
    return {
      service: new AdminService(prisma, stellar, cfg, markets, userReputation, {} as any, { notifyOrderStatus: jest.fn() } as any),
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

  it('writes nothing for a decision that changes nothing, so a double click leaves one trail and one row', async () => {
    const { service, tx, audits } = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'APPROVED', approvedAt: new Date('2026-09-01T00:00:00Z'), approvalNote: 'ok' });
    await service.setStatus('lp-1', 'APPROVED', undefined, ADMIN_ADDR);
    expect(tx.lp.update).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('writes nothing when the same status arrives with the note the row already holds', async () => {
    const { service, tx, audits } = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'SUSPENDED', approvedAt: null, approvalNote: 'took fiat' });
    await service.setStatus('lp-1', 'SUSPENDED', 'took fiat', ADMIN_ADDR);
    expect(tx.lp.update).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('still corrects the note when the same status arrives with a new one, and audits it', async () => {
    const { service, tx, audits } = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'SUSPENDED', approvedAt: null, approvalNote: 'took fiat' });
    await service.setStatus('lp-1', 'SUSPENDED', 'took fiat, twice', ADMIN_ADDR);
    expect(tx.lp.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ approvalNote: 'took fiat, twice' }) }));
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({ approvalNote: 'took fiat, twice' });
  });

  it('treats a null note like an absent one, so a client sending {"note": null} leaves no empty audit row', async () => {
    const { service, tx, audits } = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'APPROVED', approvedAt: new Date('2026-09-01T00:00:00Z'), approvalNote: 'ok' });
    await service.setStatus('lp-1', 'APPROVED', null, ADMIN_ADDR);
    expect(tx.lp.update).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('keeps approvedAt when a note is corrected on an already approved provider, and sets it only on the way into APPROVED', async () => {
    const approvedOn = new Date('2026-09-01T00:00:00Z');
    const corrected = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'APPROVED', approvedAt: approvedOn, approvalNote: 'ok' });
    await corrected.service.setStatus('lp-1', 'APPROVED', 'ok, verified again', ADMIN_ADDR);
    expect(corrected.tx.lp.update.mock.calls[0][0].data.approvedAt).toEqual(approvedOn);

    const reinstated = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'SUSPENDED', approvedAt: approvedOn, approvalNote: 'took fiat' });
    await reinstated.service.setStatus('lp-1', 'APPROVED', 'cleared', ADMIN_ADDR);
    expect(reinstated.tx.lp.update.mock.calls[0][0].data.approvedAt.getTime()).toBeGreaterThan(approvedOn.getTime());
  });

  it('applies a sanction that carries no note, conditioned on every field the administrator read: status, note, proof and contact', async () => {
    const { service, tx, audits } = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'APPROVED', approvedAt: new Date('2026-09-01T00:00:00Z'), approvalNote: 'ok', liquidityProof: 'screenshot of 50,000 USDC', contact: 'lp@example.com' });
    await service.setStatus('lp-1', 'REVOKED', undefined, ADMIN_ADDR);
    expect(tx.lp.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lp-1', status: 'APPROVED', approvalNote: 'ok', liquidityProof: 'screenshot of 50,000 USDC', contact: 'lp@example.com' },
        data: expect.objectContaining({ status: 'REVOKED' }),
      }),
    );
    expect(audits).toHaveLength(1);
  });

  it('refuses with 409 and audits nothing when the row changed between the read and the write', async () => {
    const { service, tx, audits } = svc({ id: 'lp-1', stellarAddress: LP_ADDR, status: 'PENDING', approvedAt: null, approvalNote: 'clean' });
    tx.lp.update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Record to update not found.', { code: 'P2025', clientVersion: 'test' }));
    await expect(service.setStatus('lp-1', 'APPROVED', undefined, ADMIN_ADDR)).rejects.toThrow(ConflictException);
    expect(audits).toHaveLength(0);
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
