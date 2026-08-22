import { resolveRole } from './role.util';

function makePrisma(lp: any) {
  return { lp: { findUnique: jest.fn().mockResolvedValue(lp) } } as any;
}

describe('resolveRole', () => {
  const ADMIN = 'GADMIN...';
  const LP_ADDR = 'GLP...';
  const USER_ADDR = 'GUSER...';

  it('returns admin for an allowlisted address (never even queries the DB)', async () => {
    const prisma = makePrisma(null);
    await expect(resolveRole(ADMIN, prisma, [ADMIN], 'session')).resolves.toBe('admin');
    expect(prisma.lp.findUnique).not.toHaveBeenCalled();
  });

  it('returns lp for an APPROVED Lp row', async () => {
    const prisma = makePrisma({ stellarAddress: LP_ADDR, status: 'APPROVED' });
    await expect(resolveRole(LP_ADDR, prisma, [ADMIN], 'session')).resolves.toBe('lp');
  });

  it('returns user for a PENDING/suspended Lp row (not yet/no-longer approved)', async () => {
    const prisma = makePrisma({ stellarAddress: LP_ADDR, status: 'PENDING' });
    await expect(resolveRole(LP_ADDR, prisma, [ADMIN], 'session')).resolves.toBe('user');
  });

  it('returns user for an address with no Lp row at all', async () => {
    const prisma = makePrisma(null);
    await expect(resolveRole(USER_ADDR, prisma, [ADMIN], 'session')).resolves.toBe('user');
  });

  it('admin allowlist takes precedence even if that address ALSO has an Lp row', async () => {
    const prisma = makePrisma({ stellarAddress: ADMIN, status: 'APPROVED' });
    await expect(resolveRole(ADMIN, prisma, [ADMIN], 'session')).resolves.toBe('admin');
    expect(prisma.lp.findUnique).not.toHaveBeenCalled();
  });
});
