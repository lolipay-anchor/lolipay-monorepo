import { UnauthorizedException } from '@nestjs/common';
import { resolveRole } from './role.util';
import { JwtStrategy } from './jwt.strategy';

const ADMIN = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const LP = 'GBSYTTNQVWKH2DOIWXSE6UVJXRCUIXKSC5TBPYWNLCXLS35FKH7DNOHT';

function prismaWithApprovedLp() {
  return {
    walletLink: { findUnique: jest.fn(async () => ({ status: 'ACTIVE' })) },
    lp: { findUnique: jest.fn(async () => ({ status: 'APPROVED' })) },
  } as any;
}
function prismaWithNoLp() {
  return {
    walletLink: { findUnique: jest.fn(async () => ({ status: 'ACTIVE' })) },
    lp: { findUnique: jest.fn(async () => null) },
  } as any;
}
function makeCfg(adminAddresses: string[]) {
  return { jwtSecret: 'x'.repeat(32), adminAddresses, jwtTtl: 900 } as any;
}

describe('a token class decides how far a subject may be promoted', () => {
  it('refuses to promote a sep10 subject to admin, even when the address is one', async () => {
    expect(await resolveRole(ADMIN, prismaWithNoLp(), [ADMIN], 'sep10')).toBe('user');
  });

  it('still promotes the same address to admin on a session token', async () => {
    expect(await resolveRole(ADMIN, prismaWithNoLp(), [ADMIN], 'session')).toBe('admin');
  });

  it('refuses to promote a sep10 subject to a provider, even when approved', async () => {
    expect(await resolveRole(LP, prismaWithApprovedLp(), [], 'sep10')).toBe('user');
  });

  it('still promotes the same address to a provider on a session token', async () => {
    expect(await resolveRole(LP, prismaWithApprovedLp(), [], 'session')).toBe('lp');
  });

  it('never reaches the database for a sep10 subject', async () => {
    const prisma = prismaWithApprovedLp();
    await resolveRole(LP, prisma, [], 'sep10');
    expect(prisma.lp.findUnique).not.toHaveBeenCalled();
  });
});

describe('JwtStrategy refuses a token whose class it cannot read', () => {
  function makeStrategy(adminAddresses: string[] = [ADMIN]) {
    return new JwtStrategy(makeCfg(adminAddresses), prismaWithNoLp());
  }

  it('refuses a token carrying no class at all', async () => {
    await expect(makeStrategy().validate({ sub: ADMIN } as any))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a token carrying a class it does not know', async () => {
    await expect(makeStrategy().validate({ sub: ADMIN, cls: 'interactive' } as any))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('carries the class through to the role, so a sep10 admin address is a user', async () => {
    const user = await makeStrategy().validate({ sub: ADMIN, cls: 'sep10' } as any);
    expect(user).toEqual({ address: ADMIN, role: 'user', cls: 'sep10' });
  });

  it('leaves the promotion on a session token intact', async () => {
    const user = await makeStrategy().validate({ sub: ADMIN, cls: 'session' } as any);
    expect(user).toEqual({ address: ADMIN, role: 'admin', cls: 'session' });
  });
});
