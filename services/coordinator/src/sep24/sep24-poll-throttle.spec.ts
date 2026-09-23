import 'reflect-metadata';
import { Sep24Controller } from './sep24.controller';

const proto = Sep24Controller.prototype as any;

function ttlOf(name: string): number {
  return Reflect.getMetadata('THROTTLER:TTLdefault', proto[name]);
}

function limitOf(name: string): number {
  return Reflect.getMetadata('THROTTLER:LIMITdefault', proto[name]);
}

describe('GET /sep24/transaction: limit = one wallet\'s poll cadence x its concurrent open transactions x depositors sharing one CGNAT IP', () => {
  const MEASURED_POLL_CADENCE_MS = 1_250;
  const POLLS_PER_MINUTE = 60_000 / MEASURED_POLL_CADENCE_MS;
  const OPEN_TRANSACTIONS_PER_DEPOSITOR = 3;
  const DEPOSITORS_PER_SHARED_IP = 5;

  it('60s window, limit = 48 x 3 x 5 = 720 (a single indexed findFirst, so headroom is cheap)', () => {
    expect(ttlOf('one')).toBe(60_000);
    expect(limitOf('one')).toBe(
      POLLS_PER_MINUTE * OPEN_TRANSACTIONS_PER_DEPOSITOR * DEPOSITORS_PER_SHARED_IP,
    );
    expect(limitOf('one')).toBe(720);
  });
});

describe('GET /sep24/transactions: limit = a history-screen refresh cadence x concurrent depositor sessions x depositors sharing one CGNAT IP', () => {
  const HISTORY_REFRESH_CADENCE_MS = 10_000;
  const REFRESHES_PER_MINUTE = 60_000 / HISTORY_REFRESH_CADENCE_MS;
  const CONCURRENT_SESSIONS_PER_DEPOSITOR = 3;
  const DEPOSITORS_PER_SHARED_IP = 5;

  it('60s window, limit = 6 x 3 x 5 = 90 (up to 500 rows plus a KYC query, so the multiplier stays small)', () => {
    expect(ttlOf('list')).toBe(60_000);
    expect(limitOf('list')).toBe(
      REFRESHES_PER_MINUTE * CONCURRENT_SESSIONS_PER_DEPOSITOR * DEPOSITORS_PER_SHARED_IP,
    );
    expect(limitOf('list')).toBe(90);
  });
});
