import { dailyLimitBelowMinOrderMessage, CONFIG_WRITE_CONFLICT_SENTENCE } from './config-sentence';

describe('the config-write sentences are pinned byte-for-byte, so a reword is deliberate and reviewed', () => {
  it('dailyLimitBelowMinOrderMessage, one tier below the floor', () => {
    expect(dailyLimitBelowMinOrderMessage([{ tier: 'BRONZE', base: 30_000_000n }], 50_000_000n)).toBe(
      'DAILY_LIMIT_BELOW_MIN_ORDER: the Bronze daily limit of 3 USDC is below the Min order of 5 USDC, so nobody on that tier could ever place an order — every amount is either below Min order or over the daily limit. Raise that limit, or lower Min order.',
    );
  });

  it('dailyLimitBelowMinOrderMessage, two tiers below the floor, joined with "and" and no Oxford comma', () => {
    expect(
      dailyLimitBelowMinOrderMessage(
        [
          { tier: 'BRONZE', base: 30_000_000n },
          { tier: 'SILVER', base: 40_000_000n },
        ],
        50_000_000n,
      ),
    ).toBe(
      'DAILY_LIMIT_BELOW_MIN_ORDER: the Bronze daily limit of 3 USDC and the Silver daily limit of 4 USDC are below the Min order of 5 USDC, so nobody on those tiers could ever place an order — every amount is either below Min order or over the daily limit. Raise those limits, or lower Min order.',
    );
  });

  it('dailyLimitBelowMinOrderMessage, three tiers below the floor, joined Oxford-free', () => {
    expect(
      dailyLimitBelowMinOrderMessage(
        [
          { tier: 'BRONZE', base: 10_000_000n },
          { tier: 'SILVER', base: 20_000_000n },
          { tier: 'TRUSTED', base: 30_000_000n },
        ],
        50_000_000n,
      ),
    ).toBe(
      'DAILY_LIMIT_BELOW_MIN_ORDER: the Bronze daily limit of 1 USDC, the Silver daily limit of 2 USDC and the Trusted daily limit of 3 USDC are below the Min order of 5 USDC, so nobody on those tiers could ever place an order — every amount is either below Min order or over the daily limit. Raise those limits, or lower Min order.',
    );
  });

  it('title-cases every tier name, never shouting the enum value at the operator', () => {
    expect(dailyLimitBelowMinOrderMessage([{ tier: 'GOLD', base: 10_000_000n }], 50_000_000n)).toMatch(
      /the Gold daily limit/,
    );
    expect(dailyLimitBelowMinOrderMessage([{ tier: 'GOLD', base: 10_000_000n }], 50_000_000n)).not.toMatch(
      /GOLD/,
    );
  });

  it('CONFIG_WRITE_CONFLICT_SENTENCE names no writer, since a missing Config row throws the same P2025 with nobody having written anything at all', () => {
    expect(CONFIG_WRITE_CONFLICT_SENTENCE).toBe(
      "the configuration moved between this save's read and its write, so nothing was changed",
    );
    expect(CONFIG_WRITE_CONFLICT_SENTENCE).not.toMatch(/another admin/i);
  });
});
