import { MAY_PROMOTE, resolveRole, TOKEN_CLASSES } from './role.util';

const ADMIN = 'GADMIN';

function makePrisma() {
  return {
    walletLink: { findUnique: jest.fn(async () => ({ status: 'ACTIVE' })) },
    lp: { findUnique: jest.fn(async () => ({ status: 'APPROVED' })) },
  } as any;
}

describe('a token class is powerless unless it is explicitly allowed to promote', () => {
  it.each(TOKEN_CLASSES.filter((c) => !MAY_PROMOTE.includes(c)))(
    'caps %s at user even for an allowlisted administrator',
    async (cls) => {
      await expect(resolveRole(ADMIN, makePrisma(), [ADMIN], cls)).resolves.toBe('user');
    },
  );

  it('promotes only the classes on the allowlist', async () => {
    for (const cls of MAY_PROMOTE) {
      await expect(resolveRole(ADMIN, makePrisma(), [ADMIN], cls)).resolves.toBe('admin');
    }
  });

  it('every known class is either allowed to promote or capped, never undecided', () => {
    for (const cls of TOKEN_CLASSES) {
      expect(typeof MAY_PROMOTE.includes(cls)).toBe('boolean');
    }
    expect(MAY_PROMOTE.every((c) => TOKEN_CLASSES.includes(c))).toBe(true);
  });
});
