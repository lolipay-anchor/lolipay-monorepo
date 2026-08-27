import { UnauthorizedException } from '@nestjs/common';
import { resolveRole } from './role.util';

function prismaWith(link: unknown, lpAt?: string, linkedAt: string = G) {
  return {
    walletLink: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.stellarAddress === linkedAt ? link : null,
      ),
    },
    lp: {
      findUnique: jest.fn(async ({ where }: any) =>
        lpAt && where.stellarAddress === lpAt ? { status: 'APPROVED' } : null,
      ),
    },
  } as any;
}

const ACTIVE = { status: 'ACTIVE' };
const G = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS';

describe('a subject that names a sub-identity still resolves to the account that was proven', () => {
  it('refuses a subject whose own account is unproven even when another address is linked', async () => {
    const victim = 'GVICTIM7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAA';
    const prisma = prismaWith(ACTIVE, undefined, victim);
    await expect(resolveRole(`${G}:1234`, prisma, [], 'sep10')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('looks a memoed subject up by the account before the colon', async () => {
    const prisma = prismaWith(ACTIVE);
    await expect(resolveRole(`${G}:1234`, prisma, [], 'sep10')).resolves.toBe('user');
    expect(prisma.walletLink.findUnique).toHaveBeenCalledWith({ where: { stellarAddress: G } });
  });

  it('looks a muxed subject up by its underlying account', async () => {
    const muxed = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK';
    const underlying = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
    const prisma = prismaWith(ACTIVE, undefined, underlying);
    await expect(resolveRole(muxed, prisma, [], 'sep10')).resolves.toBe('user');
    expect(prisma.walletLink.findUnique).toHaveBeenCalledWith({
      where: { stellarAddress: underlying },
    });
  });

  it('still refuses a memoed subject whose account was never proven', async () => {
    await expect(resolveRole(`${G}:1234`, prismaWith(null), [], 'sep10')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('leaves a plain subject exactly as it was', async () => {
    const prisma = prismaWith(ACTIVE);
    await expect(resolveRole(G, prisma, [], 'sep10')).resolves.toBe('user');
    expect(prisma.walletLink.findUnique).toHaveBeenCalledWith({ where: { stellarAddress: G } });
  });

  it('never lets a memo buy the role of the account it hangs off', async () => {
    const prisma = prismaWith(ACTIVE, G);
    await expect(resolveRole(`${G}:1`, prisma, [G], 'session')).resolves.toBe('user');
    await expect(resolveRole(G, prisma, [], 'session')).resolves.toBe('lp');
  });
});
