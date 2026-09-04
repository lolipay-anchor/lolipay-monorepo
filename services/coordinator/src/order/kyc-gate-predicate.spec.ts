import { OrderService } from './order.service';

const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';

type Row = {
  customerRef: string;
  personId: string | null;
  status: string;
  screenedAt: Date | null;
  deliveredAt: Date | null;
};

function verifiedRow(over: Partial<Row> = {}): Row {
  return { customerRef: G, personId: 'person-1', status: 'ACCEPTED', screenedAt: new Date(), deliveredAt: new Date(), ...over };
}

function matches(row: Row, where: any): boolean {
  if (where.personId !== undefined && row.personId !== where.personId) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.screenedAt?.not === null && row.screenedAt == null) return false;
  if (where.deliveredAt?.not === null && row.deliveredAt == null) return false;
  if (where.customerRef !== undefined && row.customerRef !== where.customerRef) return false;
  return true;
}

function dbOf(...rows: Row[]) {
  const findFirst = jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null);
  return { kycVerification: { findFirst } } as any;
}

const check = (db: any, personId: any, kycRequireAml = true) =>
  (OrderService.prototype as any).identityVerified.call({ cfg: { kycRequireAml } }, personId, db);

describe('the predicate that governs both the deposit gate and the reveal gate', () => {
  it('with KYC_REQUIRE_AML=false an accepted identity that was never screened may move funds, and with it true it may not', async () => {
    const db = dbOf(verifiedRow({ screenedAt: null }));
    expect(await check(db, 'person-1', false)).toBe(true);
    expect(await check(db, 'person-1', true)).toBe(false);
  });

  it('an acceptance the provider never delivered, the shape a stub or a self-assertion writes, opens nothing under either flag', async () => {
    const db = dbOf(verifiedRow({ screenedAt: null, deliveredAt: null }));
    expect(await check(db, 'person-1', false)).toBe(false);
    expect(await check(db, 'person-1', true)).toBe(false);
  });

  it('a refusal still blocks the person even when AML is not required', async () => {
    const db = dbOf(verifiedRow({ screenedAt: null }), verifiedRow({ customerRef: 'GOTHER', status: 'REJECTED', screenedAt: null }));
    expect(await check(db, 'person-1', false)).toBe(false);
  });

  it('accepts a verified customer bound to the person asking', async () => {
    await expect(check(dbOf(verifiedRow()), 'person-1')).resolves.toBe(true);
  });

  it('accepts a screening the person obtained under a different subject, which is the whole change', async () => {
    await expect(check(dbOf(verifiedRow({ customerRef: `${G}:2` })), 'person-1')).resolves.toBe(true);
  });

  it.each([
    ['no row at all', []],
    ['a customer still needing information', [verifiedRow({ status: 'NEEDS_INFO' })]],
    ['an acceptance no screening ever touched', [verifiedRow({ screenedAt: null })]],
    ['a screening field a mock forgot to set', [verifiedRow({ screenedAt: undefined })]],
  ])('refuses %s', async (_name, rows) => {
    await expect(check(dbOf(...(rows as Row[])), 'person-1')).resolves.toBe(false);
  });

  it('refuses a row bound to nobody, which no live row is and only a fixture can be', async () => {
    await expect(check(dbOf(verifiedRow({ personId: null })), 'person-1')).resolves.toBe(false);
  });

  it('refuses a screened row belonging to somebody else, however many of them there are', async () => {
    const db = dbOf(verifiedRow({ personId: 'person-2' }), verifiedRow({ personId: 'person-3' }));
    await expect(check(db, 'person-1')).resolves.toBe(false);
  });

  it('refuses when a refusal stands against the person, even beside an acceptance', async () => {
    const db = dbOf(verifiedRow(), verifiedRow({ customerRef: `${G}:9`, status: 'REJECTED' }));
    await expect(check(db, 'person-1')).resolves.toBe(false);
  });

  it('asks about acceptance and refusal separately, so one cannot answer for the other', async () => {
    const db = dbOf(verifiedRow());
    await check(db, 'person-1');
    expect(db.kycVerification.findFirst).toHaveBeenCalledTimes(2);
    expect(db.kycVerification.findFirst.mock.calls[0][0].where).toEqual({
      personId: 'person-1',
      status: 'ACCEPTED',
      screenedAt: { not: null },
    });
    expect(db.kycVerification.findFirst.mock.calls[1][0].where).toEqual({
      personId: 'person-1',
      status: 'REJECTED',
    });
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['null', null],
  ])('refuses outright when the person is %s, rather than asking a question that has no filter', async (_n, personId) => {
    const db = dbOf(verifiedRow({ personId: null }));
    await expect(check(db, personId)).resolves.toBe(false);
    expect(db.kycVerification.findFirst).not.toHaveBeenCalled();
  });
});
