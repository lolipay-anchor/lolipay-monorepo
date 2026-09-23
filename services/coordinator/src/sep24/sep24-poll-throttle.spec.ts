import 'reflect-metadata';
import { Sep24Controller } from './sep24.controller';

const proto = Sep24Controller.prototype as any;

function ttlOf(name: string): number {
  return Reflect.getMetadata('THROTTLER:TTLdefault', proto[name]);
}

function limitOf(name: string): number {
  return Reflect.getMetadata('THROTTLER:LIMITdefault', proto[name]);
}

const DEPOSITORS_PER_SHARED_IP = 5;

describe("GET /sep24/transaction: limit = one wallet's PEAK poll cadence (a ceiling needs the peak, not the 3s median of 2s x157/3s x341/4s x98) x its concurrent open transactions x depositors sharing one CGNAT IP", () => {
  const PEAK_POLL_CADENCE_MS = 2_000;
  const POLLS_PER_MINUTE = 60_000 / PEAK_POLL_CADENCE_MS;
  const OPEN_TRANSACTIONS_PER_DEPOSITOR_OBSERVED_FLOOR_NOT_A_CEILING = 3;

  it('60s window, limit = 30 x 3 x 5 = 450, clearing the ~60-61 one depositor alone reached against the old 60 limit', () => {
    expect(ttlOf('one')).toBe(60_000);
    expect(limitOf('one')).toBe(
      POLLS_PER_MINUTE * OPEN_TRANSACTIONS_PER_DEPOSITOR_OBSERVED_FLOOR_NOT_A_CEILING * DEPOSITORS_PER_SHARED_IP,
    );
    expect(limitOf('one')).toBe(450);
  });
});

describe('GET /sep24/transactions: limit = an ASSUMED (not measured -- 2 requests all day) history-screen refresh cadence x concurrent depositor sessions x depositors sharing one CGNAT IP', () => {
  const ASSUMED_HISTORY_REFRESH_CADENCE_MS = 10_000;
  const REFRESHES_PER_MINUTE = 60_000 / ASSUMED_HISTORY_REFRESH_CADENCE_MS;
  const CONCURRENT_SESSIONS_PER_DEPOSITOR = 3;

  it('60s window, limit = 6 x 3 x 5 = 90 (up to 500 rows plus a KYC query, so the multiplier stays small; ~45x the observed peak of 2/day)', () => {
    expect(ttlOf('list')).toBe(60_000);
    expect(limitOf('list')).toBe(
      REFRESHES_PER_MINUTE * CONCURRENT_SESSIONS_PER_DEPOSITOR * DEPOSITORS_PER_SHARED_IP,
    );
    expect(limitOf('list')).toBe(90);
  });
});
