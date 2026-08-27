import { OrderService } from './order.service';

const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

function verifiedRow(over: Record<string, unknown> = {}) {
  return { customerRef: G, personId: 'person-1', status: 'ACCEPTED', screenedAt: new Date(), ...over };
}

function dbWith(row: unknown, refused: unknown = null) {
  return {
    kycVerification: {
      findUnique: jest.fn().mockResolvedValue(row),
      findFirst: jest.fn(async ({ where }: any) =>
        where.personId === undefined ? { customerRef: 'SOMEBODY-ELSE' } : refused,
      ),
    },
  } as any;
}

const check = (db: any, address: string, personId: any) =>
  (OrderService.prototype as any).identityVerified.call({}, address, personId, db);

describe('the predicate that governs both the deposit gate and the reveal gate', () => {
  it('accepts a verified customer bound to the person asking', async () => {
    await expect(check(dbWith(verifiedRow()), G, 'person-1')).resolves.toBe(true);
  });

  it.each([
    ['no row at all', null],
    ['a customer still needing information', verifiedRow({ status: 'NEEDS_INFO' })],
    ['an acceptance no screening ever touched', verifiedRow({ screenedAt: null })],
    ['a screening field a mock forgot to set', verifiedRow({ screenedAt: undefined })],
  ])('refuses %s', async (_name, row) => {
    await expect(check(dbWith(row), G, 'person-1')).resolves.toBe(false);
  });

  it('refuses a row bound to somebody else, which a re-linked wallet would leave behind', async () => {
    await expect(check(dbWith(verifiedRow({ personId: 'person-2' })), G, 'person-1')).resolves.toBe(
      false,
    );
  });

  it('refuses when a refusal stands against the person', async () => {
    await expect(
      check(dbWith(verifiedRow(), { customerRef: `${G}:9` }), G, 'person-1'),
    ).resolves.toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['null', null],
  ])('refuses outright when the person is %s, rather than asking a question that has no filter', async (_n, personId) => {
    const db = dbWith(verifiedRow());
    await expect(check(db, G, personId)).resolves.toBe(false);
    expect(db.kycVerification.findFirst).not.toHaveBeenCalled();
  });
});
