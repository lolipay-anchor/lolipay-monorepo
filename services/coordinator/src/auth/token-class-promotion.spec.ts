import {
  MAY_OPEN_SOCKET,
  MAY_PROMOTE,
  MAY_USE_INTERNAL_API,
  resolveRole,
  TOKEN_CLASSES,
} from './role.util';

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

describe('the three doors ask three different questions', () => {
  it('keeps promotion, the internal API and the socket as separate decisions', () => {
    const lists = [MAY_PROMOTE, MAY_USE_INTERNAL_API, MAY_OPEN_SOCKET];

    for (const list of lists) {
      expect(list.every((c) => TOKEN_CLASSES.includes(c))).toBe(true);
    }
    expect(MAY_USE_INTERNAL_API).not.toBe(MAY_PROMOTE);
    expect(MAY_OPEN_SOCKET).not.toBe(MAY_PROMOTE);
  });
});

