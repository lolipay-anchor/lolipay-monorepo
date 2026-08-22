import { UnauthorizedException } from '@nestjs/common';
import { resolveRole } from './role.util';

const ADMIN = 'GADMIN';
const LP_ADDR = 'GLP';
const USER_ADDR = 'GUSER';

function makePrisma(opts: { link?: any; lp?: any } = {}) {
  return {
    walletLink: {
      findUnique: jest.fn().mockResolvedValue(
        'link' in opts ? opts.link : { stellarAddress: USER_ADDR, status: 'ACTIVE' },
      ),
    },
    lp: { findUnique: jest.fn().mockResolvedValue(opts.lp ?? null) },
  } as any;
}

describe('a session is only ever granted to a proven wallet', () => {
  it('refuses an address that has never been linked to a person', async () => {
    const prisma = makePrisma({ link: null });

    await expect(resolveRole(USER_ADDR, prisma, [ADMIN], 'session')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses an address whose link has been revoked', async () => {
    const prisma = makePrisma({ link: { stellarAddress: USER_ADDR, status: 'REVOKED' } });

    await expect(resolveRole(USER_ADDR, prisma, [ADMIN], 'session')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses an allowlisted administrator whose wallet is not proven', async () => {
    const prisma = makePrisma({ link: null });

    await expect(resolveRole(ADMIN, prisma, [ADMIN], 'session')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.lp.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a provider whose wallet is not proven, before consulting the provider table', async () => {
    const prisma = makePrisma({ link: null, lp: { status: 'APPROVED' } });

    await expect(resolveRole(LP_ADDR, prisma, [ADMIN], 'session')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.lp.findUnique).not.toHaveBeenCalled();
  });

  it('still resolves the ordinary roles once the wallet is proven', async () => {
    const asAdmin = makePrisma({ link: { status: 'ACTIVE' } });
    const asLp = makePrisma({ link: { status: 'ACTIVE' }, lp: { status: 'APPROVED' } });
    const asUser = makePrisma({ link: { status: 'ACTIVE' } });

    await expect(resolveRole(ADMIN, asAdmin, [ADMIN], 'session')).resolves.toBe('admin');
    await expect(resolveRole(LP_ADDR, asLp, [ADMIN], 'session')).resolves.toBe('lp');
    await expect(resolveRole(USER_ADDR, asUser, [ADMIN], 'session')).resolves.toBe('user');
  });

  it('holds for a sep10 token too, which is still capped at user', async () => {
    const proven = makePrisma({ link: { status: 'ACTIVE' } });
    const unproven = makePrisma({ link: null });

    await expect(resolveRole(ADMIN, proven, [ADMIN], 'sep10')).resolves.toBe('user');
    await expect(resolveRole(ADMIN, unproven, [ADMIN], 'sep10')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
