import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { acceptedForFunds, acceptedUnscreenedSince, awaitingProvider, popupMayOfferVendor, staleAcceptance, SESSION_LIFETIME_MS, deliveredButUnreadable, refusedAfterDelivery, screeningDidNotRun, HIT_REFUSAL, SCREENING_DID_NOT_RUN, SCREENING_REQUIRED_FAILED, UNREADABLE_DECLINE, UNREADABLE_SCREENING } from './screening-requirement';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'generated' ? [] : sourceFiles(p);
    return /\.ts$/.test(name) && !/\.(spec|e2e-spec)\.ts$/.test(name) && !p.endsWith('/order/test-helpers.ts') ? [p] : [];
  });
}

describe('whether a customer may move funds depends on one predicate that reads KYC_REQUIRE_AML', () => {
  it('demands a completed screening when AML is required, and a provider delivery when it is not, and nothing else under either value', () => {
    expect(acceptedForFunds(true)).toEqual({ status: 'ACCEPTED', screenedAt: { not: null } });
    expect(acceptedForFunds(false)).toEqual({ status: 'ACCEPTED', deliveredAt: { not: null } });
  });

  it('answers PROCESSING for exactly the accepted rows the gate would refuse on the row alone', () => {
    const delivered = { status: 'ACCEPTED', screenedAt: null, deliveredAt: new Date() };
    const screened = { status: 'ACCEPTED', screenedAt: new Date(), deliveredAt: new Date() };
    const stub = { status: 'ACCEPTED', screenedAt: null, deliveredAt: null };
    expect(awaitingProvider(delivered, true)).toBe(true);
    expect(awaitingProvider(delivered, false)).toBe(false);
    expect(awaitingProvider(screened, true)).toBe(false);
    expect(awaitingProvider(screened, false)).toBe(false);
    expect(awaitingProvider(stub, true)).toBe(true);
    expect(awaitingProvider(stub, false)).toBe(true);
    expect(awaitingProvider({ ...stub, status: 'REJECTED' }, false)).toBe(false);
  });

  it('names a delivery this anchor could not read by the marker only the unreadable branch writes, so an abandoned session, an expired one or a blurry document is not counted as vendor drift', () => {
    expect(deliveredButUnreadable()).toEqual({ status: 'NEEDS_INFO', rejectionReason: UNREADABLE_SCREENING });
  });

  it('no other source file reads the screening fields or calls the session-freshness predicate, so no gate can require or skip the provider behind the switch and no fourth caller can judge a session stale', () => {
    const allowed = ['screening-requirement.ts', 'sep12.service.ts', 'sep24.service.ts'];
    const offenders = sourceFiles(join(__dirname, '..'))
      .filter((p) => !allowed.some((a) => p.endsWith(a)))
      .filter((p) => /\b(screenedAt|deliveredAt|verifiedAt|popupMayOfferVendor|awaitingProvider|staleAcceptance|stillInFlight|needsNewSession)\b/.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('sep12.service touches the screening fields and the session-freshness fields, directly or through a shared predicate, only on the lines listed here, so any new read there fails until it is consciously listed', () => {
    const lines = readFileSync(join(__dirname, 'sep12.service.ts'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /\b(screenedAt|deliveredAt|verifiedAt|popupMayOfferVendor|awaitingProvider|staleAcceptance|stillInFlight|needsNewSession|providerRef|updatedAt)\b/.test(l));
    expect(lines).toEqual([
      "import { awaitingProvider, popupMayOfferVendor, staleAcceptance, SESSION_LIFETIME_MS } from './screening-requirement';",
      'export function stillInFlight(',
      'row: { status: string; providerRef: string | null; updatedAt: Date | null } | null | undefined,',
      "if (row?.status !== 'PROCESSING' || !row.providerRef) return false;",
      'return row.updatedAt == null || row.updatedAt.getTime() > Date.now() - SESSION_LIFETIME_MS;',
      'export function needsNewSession(',
      'providerRef: string | null;',
      'updatedAt: Date | null;',
      'screenedAt: Date | null;',
      'deliveredAt: Date | null;',
      'verifiedAt: Date | null;',
      "return (row?.status === 'PROCESSING' && !stillInFlight(row)) || staleAcceptance(row, requireAml);",
      "if ((settled?.status === 'ACCEPTED' && !staleAcceptance(settled, this.cfg.kycRequireAml)) || stillInFlight(settled)) return;",
      'providerRef: null,',
      'verifiedAt: null,',
      'async applyDelivery(conclusion: DiditConclusion, deliveredAt: Date): Promise<void> {',
      'standing.providerRef &&',
      'standing.providerRef !== conclusion.providerRef',
      'if (!refusing && standing.deliveredAt && standing.deliveredAt > deliveredAt) return;',
      'await this.writeDelivery(tx, customerRef, person.id, conclusion, deliveredAt, standing);',
      'deliveredAt: Date,',
      'standing: { deliveredAt: Date | null } | null,',
      'providerRef: conclusion.providerRef ?? null,',
      'deliveredAt: conclusion.notStarted ? (standing?.deliveredAt ?? null) : deliveredAt,',
      'screenedAt: screened ? deliveredAt : null,',
      "verifiedAt: conclusion.status === 'ACCEPTED' ? deliveredAt : null,",
      'if (needsNewSession(row, this.cfg.kycRequireAml)) {',
      'if (awaitingProvider(row, this.cfg.kycRequireAml)) {',
      "const providerPage = row.verificationUrl?.startsWith('https://') && popupMayOfferVendor(row) && stillInFlight(row) ? row.verificationUrl : null;",
      'data: { rejectionReason: null, screenedAt: null, verifiedAt: null, verificationUrl: null, providerRef: null, environment: null },',
      "if (inFlight?.status === 'ACCEPTED' && !staleAcceptance(inFlight, this.cfg.kycRequireAml)) {",
      'if (stillInFlight(inFlight)) {',
      'providerRef: decision.providerRef ?? null,',
      "verifiedAt: decision.status === 'ACCEPTED' ? new Date() : null,",
      'screenedAt: null,',
      'deliveredAt: null,',
      "(settledMeanwhile?.status === 'ACCEPTED' && !staleAcceptance(settledMeanwhile, this.cfg.kycRequireAml)) ||",
      '(stillInFlight(settledMeanwhile) && settledMeanwhile!.providerRef !== decision.providerRef)',
    ]);
  });

  it('screening-requirement touches screenedAt and deliveredAt only in the predicates listed here, so a new reader there fails until it is consciously listed', () => {
    const lines = readFileSync(join(__dirname, 'screening-requirement.ts'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /\b(screenedAt|deliveredAt|verifiedAt|stillInFlight|needsNewSession|providerRef|updatedAt)\b/.test(l));
    expect(lines).toEqual([
      "? { status: 'ACCEPTED' as const, screenedAt: { not: null } }",
      ": { status: 'ACCEPTED' as const, deliveredAt: { not: null } };",
      'row: { status: string; screenedAt: Date | null; deliveredAt: Date | null },',
      'return requireAml ? row.screenedAt === null : row.deliveredAt === null;',
      'row: { status: string; screenedAt: Date | null; deliveredAt: Date | null; verifiedAt: Date | null } | null | undefined,',
      "if (row?.status !== 'ACCEPTED' || row.screenedAt != null) return false;",
      'if (row.deliveredAt != null) return requireAml;',
      'return row.verifiedAt != null && row.verifiedAt.getTime() < Date.now() - SESSION_LIFETIME_MS;',
      "return { status: 'REJECTED' as const, deliveredAt: { gte: since } };",
      "return { status: 'ACCEPTED' as const, screenedAt: null, deliveredAt: { gte: since } };",
      'export function popupMayOfferVendor(row: { status: string; deliveredAt: Date | null } | null | undefined): boolean {',
      "return row.status !== 'ACCEPTED' && !(row.status === 'PROCESSING' && row.deliveredAt !== null);",
    ]);
  });

  it('names a screening the vendor could not run by its own marker, apart from the unreadable one, so a vendor outage and a payload drift are never one number', () => {
    expect(screeningDidNotRun()).toEqual({ status: 'NEEDS_INFO', rejectionReason: SCREENING_DID_NOT_RUN });
    expect(new Set([SCREENING_DID_NOT_RUN, UNREADABLE_SCREENING, HIT_REFUSAL, SCREENING_REQUIRED_FAILED, UNREADABLE_DECLINE]).size).toBe(5);
  });

  it('names a refusal written after a provider delivery inside a window by status and time alone, so a customer erasing their reason under SEP-12 DELETE does not erase it from the count', () => {
    const since = new Date('2026-09-04T00:00:00Z');
    expect(refusedAfterDelivery(since)).toEqual({ status: 'REJECTED', deliveredAt: { gte: since } });
  });

  it('names an acceptance delivered inside a window with no screening, which is drift only when the bound workflow performs AML', () => {
    const since = new Date('2026-09-04T00:00:00Z');
    expect(acceptedUnscreenedSince(since)).toEqual({ status: 'ACCEPTED', screenedAt: null, deliveredAt: { gte: since } });
  });
});

describe('whether the popup may still offer the vendor page, which decides only what the popup shows and never who may move funds', () => {
  it('is false once the identity is accepted, and once a processing session carries a delivery time', () => {
    expect(popupMayOfferVendor({ status: 'ACCEPTED', deliveredAt: null })).toBe(false);
    expect(popupMayOfferVendor({ status: 'PROCESSING', deliveredAt: new Date() })).toBe(false);
  });

  it('is true for a session the vendor has only created, for a row still to be written, and for a refusal or a resubmission', () => {
    expect(popupMayOfferVendor({ status: 'PROCESSING', deliveredAt: null })).toBe(true);
    expect(popupMayOfferVendor(null)).toBe(true);
    expect(popupMayOfferVendor({ status: 'NEEDS_INFO', deliveredAt: new Date() })).toBe(true);
    expect(popupMayOfferVendor({ status: 'REJECTED', deliveredAt: new Date() })).toBe(true);
  });
});

describe('the popup reads the screening fields and the session-freshness fields only through the shared predicates, on the lines listed here', () => {
  it('sep24.service touches them on exactly these lines, so any new read there fails until it is consciously listed', () => {
    const lines = readFileSync(join(__dirname, '..', 'sep24', 'sep24.service.ts'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /\b(screenedAt|deliveredAt|verifiedAt|popupMayOfferVendor|awaitingProvider|staleAcceptance|stillInFlight|needsNewSession|providerRef|updatedAt)\b/.test(l));
    expect(lines).toEqual([
      "import { acceptedForFunds, popupMayOfferVendor } from '../kyc/screening-requirement';",
      "import { Sep12Service, needsNewSession } from '../kyc/sep12.service';",
      'const restarted = needsNewSession(kyc, this.cfg.kycRequireAml)',
      'if (vendor && popupMayOfferVendor(kyc)) {',
      '| { status: KycStatus; providerRef: string | null; updatedAt: Date | null; screenedAt: Date | null; deliveredAt: Date | null; verifiedAt: Date | null }',
      "kycStatus: screened ? 'ACCEPTED' : needsNewSession(kyc, this.cfg.kycRequireAml) ? 'NEEDS_INFO' : (kyc?.status ?? null),",
    ]);
  });
});


describe('an acceptance the provider never delivered, old enough that it never will, reopens the form instead of reporting progress that cannot happen', () => {
  const now = 1_800_000_000_000;
  let clock: jest.SpyInstance;

  beforeEach(() => {
    clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(() => {
    clock.mockRestore();
  });

  const stale = new Date(now - (SESSION_LIFETIME_MS + 60_000));
  const fresh = new Date(now - 60_000);

  it('holds the window at exactly one day, stated as a literal here so that moving the constant or loosening the comparison turns this red instead of riding along with the fixtures', () => {
    const DAY = 24 * 60 * 60 * 1000;
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: null, screenedAt: null, verifiedAt: new Date(now - DAY) }, true)).toBe(false);
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: null, screenedAt: null, verifiedAt: new Date(now - DAY) }, false)).toBe(false);
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: null, screenedAt: null, verifiedAt: new Date(now - DAY - 1) }, true)).toBe(true);
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: null, screenedAt: null, verifiedAt: new Date(now - DAY - 1) }, false)).toBe(true);
  });

  it('reopens an accepted row that carries no delivery and was verified longer ago than a session can live', () => {
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: null, screenedAt: null, verifiedAt: stale }, true)).toBe(true);
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: null, screenedAt: null, verifiedAt: stale }, false)).toBe(true);
  });

  it('leaves an acceptance written seconds ago alone, because that is the shape a synchronous provider writes on the PUT itself, and staleness is the only thing separating it from a row that has been lying to someone for months', () => {
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: null, screenedAt: null, verifiedAt: fresh }, true)).toBe(false);
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: null, screenedAt: null, verifiedAt: fresh }, false)).toBe(false);
  });

  it('leaves a delivered acceptance alone however old it is where a delivery is the whole of what the money gate asks for, because that customer is settled and must never be sent round again', () => {
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: stale, screenedAt: null, verifiedAt: stale }, false)).toBe(false);
  });

  it('reopens that same row where the money gate asks for a screening, because the provider has already answered for that session and will never answer it again, so reporting progress on it promises an event that cannot happen', () => {
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: stale, screenedAt: null, verifiedAt: stale }, true)).toBe(true);
  });

  it('leaves a screened acceptance alone, so nobody the money gate admits under either value of the AML switch is ever sent round again', () => {
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: stale, screenedAt: stale, verifiedAt: stale }, true)).toBe(false);
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: stale, screenedAt: stale, verifiedAt: stale }, false)).toBe(false);
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: null, screenedAt: stale, verifiedAt: stale }, true)).toBe(false);
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: null, screenedAt: stale, verifiedAt: stale }, false)).toBe(false);
  });

  it('treats a row nothing ever stamped as not stale, because writing that comparison the other way round reopens every unstamped acceptance ever written', () => {
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: null, screenedAt: null, verifiedAt: null }, true)).toBe(false);
    expect(staleAcceptance({ status: 'ACCEPTED', deliveredAt: null, screenedAt: null, verifiedAt: null }, false)).toBe(false);
  });

  it('reads the row and the AML switch it is handed, and never which provider is bound, so it cannot behave one way in the suite and another in production', () => {
    for (const requireAml of [true, false]) {
      expect(staleAcceptance({ status: 'PROCESSING', deliveredAt: null, screenedAt: null, verifiedAt: stale }, requireAml)).toBe(false);
      expect(staleAcceptance({ status: 'NEEDS_INFO', deliveredAt: null, screenedAt: null, verifiedAt: stale }, requireAml)).toBe(false);
      expect(staleAcceptance({ status: 'REJECTED', deliveredAt: null, screenedAt: null, verifiedAt: stale }, requireAml)).toBe(false);
      expect(staleAcceptance({ status: 'REJECTED', deliveredAt: stale, screenedAt: null, verifiedAt: stale }, requireAml)).toBe(false);
      expect(staleAcceptance(null, requireAml)).toBe(false);
      expect(staleAcceptance(undefined, requireAml)).toBe(false);
    }
  });
});
