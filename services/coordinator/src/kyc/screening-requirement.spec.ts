import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { acceptedForFunds, awaitingProvider, deliveredButUnreadable, screeningDidNotRun, HIT_REFUSAL, SCREENING_DID_NOT_RUN, UNREADABLE_REFUSAL, UNREADABLE_SCREENING } from './screening-requirement';

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

  it('no other source file reads screenedAt or deliveredAt, so no gate can require or skip the provider behind the switch', () => {
    const allowed = ['screening-requirement.ts', 'sep12.service.ts'];
    const offenders = sourceFiles(join(__dirname, '..'))
      .filter((p) => !allowed.some((a) => p.endsWith(a)))
      .filter((p) => /\b(screenedAt|deliveredAt)\b/.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('sep12.service touches screenedAt and deliveredAt only on the lines that write them and the one delivery-order guard, so any new read there fails until it is consciously listed', () => {
    const lines = readFileSync(join(__dirname, 'sep12.service.ts'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /\b(screenedAt|deliveredAt)\b/.test(l));
    expect(lines).toEqual([
      'async applyDelivery(conclusion: DiditConclusion, deliveredAt: Date): Promise<void> {',
      'if (!refusing && standing.deliveredAt && standing.deliveredAt > deliveredAt) return;',
      'await this.writeDelivery(tx, customerRef, person.id, conclusion, deliveredAt, standing);',
      'deliveredAt: Date,',
      'deliveredAt,',
      'screenedAt: screened ? deliveredAt : null,',
      "verifiedAt: conclusion.status === 'ACCEPTED' ? deliveredAt : null,",
      'data: { rejectionReason: null, screenedAt: null, verifiedAt: null },',
      'screenedAt: null,',
      'deliveredAt: null,',
    ]);
  });

  it('names a screening the vendor could not run by its own marker, apart from the unreadable one, so a vendor outage and a payload drift are never one number', () => {
    expect(screeningDidNotRun()).toEqual({ status: 'NEEDS_INFO', rejectionReason: SCREENING_DID_NOT_RUN });
    expect(new Set([SCREENING_DID_NOT_RUN, UNREADABLE_SCREENING, HIT_REFUSAL, UNREADABLE_REFUSAL]).size).toBe(4);
  });
});
