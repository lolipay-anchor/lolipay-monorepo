import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const M = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK';

function strategyOver(linkedAt: string) {
  const cfg = { jwtSecret: 'x'.repeat(48), jwtIssuer: 'https://api.example.test', jwtAudience: 'api.example.test', adminAddresses: [] } as any;
  const prisma = {
    walletLink: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.stellarAddress === linkedAt ? { status: 'ACTIVE' } : null,
      ),
    },
    lp: { findUnique: jest.fn().mockResolvedValue(null) },
  } as any;
  return new JwtStrategy(cfg, prisma);
}

describe('a token subject the anchor never mints is refused at the door', () => {
  it.each([
    ['not an address', 'not-an-address'],
    ['a colon with nothing before it', ':1234'],
    ['a subject wearing several colons', `${G}:1:2`],
    ['a memo that is not a number', `${G}:abc`],
    ['a truncated muxed address', 'MBOGUS'],
  ])('refuses %s, naming the shape as the reason', async (_name, sub) => {
    await expect(strategyOver(G).validate({ sub, cls: 'sep10' })).rejects.toThrow(
      'token subject is not an address this anchor mints',
    );
  });

  it('still reports an absent subject as absent rather than as misshapen', async () => {
    await expect(strategyOver(G).validate({ sub: '', cls: 'sep10' })).rejects.toThrow(
      'token subject missing',
    );
  });

  it('leaves a well-shaped but unproven address to the wallet check, not the shape check', async () => {
    const unproven = `${G.slice(0, -1)}X`;
    await expect(strategyOver(G).validate({ sub: unproven, cls: 'sep10' })).rejects.toThrow(
      'address is not a proven wallet',
    );
  });

  it.each([
    ['a plain account', G, G],
    ['an account carrying a memo', `${G}:1234`, G],
    ['a muxed account', M, G],
  ])('admits %s', async (_name, sub, linkedAt) => {
    await expect(strategyOver(linkedAt).validate({ sub, cls: 'sep10' })).resolves.toEqual({
      address: sub,
      role: 'user',
      cls: 'sep10',
    });
  });
});
