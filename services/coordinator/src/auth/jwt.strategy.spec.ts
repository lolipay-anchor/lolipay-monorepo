import { JwtStrategy } from './jwt.strategy';

function makeStrategy(lp: any, adminAddresses: string[] = []) {
  const cfg = { jwtSecret: 'z'.repeat(40), jwtIssuer: 'https://lolipay.app', jwtAudience: 'lolipay-app', adminAddresses } as any;
  const prisma = {
    walletLink: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    lp: { findUnique: jest.fn().mockResolvedValue(lp) },
  } as any;
  return { strategy: new JwtStrategy(cfg, prisma), prisma };
}

describe('JwtStrategy.validate (live role via shared resolveRole)', () => {
  it('attaches {address, role:"user"} for an address with no Lp row', async () => {
    const { strategy } = makeStrategy(null);
    await expect(strategy.validate({ sub: 'GUSER', cls: 'session' } as any)).resolves.toEqual({
      address: 'GUSER',
      role: 'user',
      cls: 'session',
    });
  });

  it('attaches role:"lp" for an APPROVED Lp', async () => {
    const { strategy } = makeStrategy({ status: 'APPROVED' });
    await expect(strategy.validate({ sub: 'GLP', cls: 'session' } as any)).resolves.toEqual({
      address: 'GLP',
      role: 'lp',
      cls: 'session',
    });
  });

  it('attaches role:"admin" for an allowlisted address, ignoring any Lp row', async () => {
    const { strategy, prisma } = makeStrategy({ status: 'APPROVED' }, ['GADMIN']);
    await expect(strategy.validate({ sub: 'GADMIN', cls: 'session' } as any)).resolves.toEqual({
      address: 'GADMIN',
      role: 'admin',
      cls: 'session',
    });
    expect(prisma.lp.findUnique).not.toHaveBeenCalled();
  });

  it('demotes a suspended (non-APPROVED) LP back to "user" live, even with a stale token', async () => {
    const { strategy } = makeStrategy({ status: 'SUSPENDED' });
    await expect(strategy.validate({ sub: 'GLP', cls: 'session' } as any)).resolves.toEqual({
      address: 'GLP',
      role: 'user',
      cls: 'session',
    });
  });
});
