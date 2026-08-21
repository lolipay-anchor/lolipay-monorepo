import { JwtStrategy } from './jwt.strategy';

function makeStrategy(lp: any, adminAddresses: string[] = []) {
  const cfg = { jwtSecret: 'z'.repeat(40), adminAddresses } as any;
  const prisma = { lp: { findUnique: jest.fn().mockResolvedValue(lp) } } as any;
  return { strategy: new JwtStrategy(cfg, prisma), prisma };
}

describe('JwtStrategy.validate (live role via shared resolveRole)', () => {
  it('attaches {address, role:"user"} for an address with no Lp row', async () => {
    const { strategy } = makeStrategy(null);
    await expect(strategy.validate({ sub: 'GUSER' })).resolves.toEqual({
      address: 'GUSER',
      role: 'user',
    });
  });

  it('attaches role:"lp" for an APPROVED Lp', async () => {
    const { strategy } = makeStrategy({ status: 'APPROVED' });
    await expect(strategy.validate({ sub: 'GLP' })).resolves.toEqual({
      address: 'GLP',
      role: 'lp',
    });
  });

  it('attaches role:"admin" for an allowlisted address, ignoring any Lp row', async () => {
    const { strategy, prisma } = makeStrategy({ status: 'APPROVED' }, ['GADMIN']);
    await expect(strategy.validate({ sub: 'GADMIN' })).resolves.toEqual({
      address: 'GADMIN',
      role: 'admin',
    });
    expect(prisma.lp.findUnique).not.toHaveBeenCalled();
  });

  it('demotes a suspended (non-APPROVED) LP back to "user" live, even with a stale token', async () => {
    const { strategy } = makeStrategy({ status: 'SUSPENDED' });
    await expect(strategy.validate({ sub: 'GLP' })).resolves.toEqual({
      address: 'GLP',
      role: 'user',
    });
  });
});
