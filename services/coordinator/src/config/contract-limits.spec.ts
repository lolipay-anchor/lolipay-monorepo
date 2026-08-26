import * as fs from 'fs';
import * as path from 'path';
import {
  MIN_PAY_WINDOW_SECS,
  MAX_PAY_WINDOW_SECS,
  MAX_TOTAL_WINDOW_SECS,
  MAX_DISPUTE_WINDOW_SECS,
  RESOLVER_WINDOW_SECS,
  POST_VERDICT_GRACE_SECS,
  LONGEST_TAIL_PAST_SETTLEMENT_SECS,
  cooldownFloorSecs,
  windowsFitTheContract,
} from './contract-limits';

const LIB_RS = path.resolve(__dirname, '../../../../contracts/escrow/src/lib.rs');
const STAKING_RS = path.resolve(__dirname, '../../../../contracts/staking/src/lib.rs');

function rustNumber(file: string, name: string): number {
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(new RegExp(`const ${name}: u64 = ([^;]+);`));
  if (!m) throw new Error(`could not find const ${name} in ${file}`);
  const expr = m[1].replace(/_/g, '').trim();
  if (!/^[0-9+*\s]+$/.test(expr)) throw new Error(`${name} is not plain arithmetic: ${expr}`);
  return Function(`return (${expr})`)() as number;
}

function rustConst(name: string): number {
  return rustNumber(LIB_RS, name);
}

describe('the coordinator mirrors the escrow contract deadline bounds', () => {
  it('MIN_PAY_WINDOW matches the contract', () => {
    expect(MIN_PAY_WINDOW_SECS).toBe(rustConst('MIN_PAY_WINDOW'));
  });

  it('MAX_PAY_WINDOW matches the contract', () => {
    expect(MAX_PAY_WINDOW_SECS).toBe(rustConst('MAX_PAY_WINDOW'));
  });

  it('MAX_TOTAL_WINDOW matches the contract', () => {
    expect(MAX_TOTAL_WINDOW_SECS).toBe(rustConst('MAX_TOTAL_WINDOW'));
  });

  it('MAX_DISPUTE_WINDOW matches the contract', () => {
    expect(MAX_DISPUTE_WINDOW_SECS).toBe(rustConst('MAX_DISPUTE_WINDOW'));
  });

  it('RESOLVER_WINDOW matches the contract', () => {
    expect(RESOLVER_WINDOW_SECS).toBe(rustConst('RESOLVER_WINDOW'));
  });

  it('POST_VERDICT_GRACE is still the resolver window, as the contract defines it', () => {
    const src = fs.readFileSync(LIB_RS, 'utf8');
    expect(src).toContain('const POST_VERDICT_GRACE: u64 = RESOLVER_WINDOW;');
    expect(POST_VERDICT_GRACE_SECS).toBe(RESOLVER_WINDOW_SECS);
  });

  it("the staking contract's own cooldown floor is exactly the tail past settlement, plus a second", () => {
    expect(rustNumber(STAKING_RS, 'MIN_COOLDOWN_SECS')).toBe(
      LONGEST_TAIL_PAST_SETTLEMENT_SECS + 1,
    );
  });
});

describe('the cooldown floor no contract constant can reach', () => {
  it('adds the pay and confirm windows the staking contract cannot know about', () => {
    expect(cooldownFloorSecs(1800, 1800)).toBe(349_201);
  });

  it('accepts a deployed cooldown that clears the floor', () => {
    expect(windowsFitTheContract(1800, 1800, 7200, 349_201)).toBeNull();
  });

  it('refuses a window change that would put the floor above the deployed cooldown', () => {
    expect(windowsFitTheContract(86_400, 1800, 7200, 349_201)).toMatch(/cooldown/i);
  });

  it('leaves the check alone when the deployed cooldown is not known', () => {
    expect(windowsFitTheContract(1800, 1800, 7200)).toBeNull();
  });
});

describe('windowsFitTheContract', () => {
  it('accepts the shipped defaults', () => {
    expect(windowsFitTheContract(1800, 1800, 7200)).toBeNull();
  });

  it('rejects a pay window under the contract floor', () => {
    expect(windowsFitTheContract(599, 1800, 7200)).toMatch(/at least 600/);
  });

  it('rejects a pay window over the contract ceiling — the value that bricked funding', () => {
    expect(windowsFitTheContract(100_000, 1800, 7200)).toMatch(/at most 86400/);
  });

  it('accepts a pay window exactly at each bound', () => {
    expect(windowsFitTheContract(600, 1, 1)).toBeNull();
    expect(windowsFitTheContract(86_400, 1, 1)).toBeNull();
  });

  it('rejects a total beyond the contract maximum even when each part looks reasonable', () => {
    expect(windowsFitTheContract(86_400, 1_300_000, 1_300_000)).toMatch(/at most 2592000/);
  });

  it('accepts a total exactly at the maximum', () => {
    expect(windowsFitTheContract(86_400, 1_000_000, 1_505_600)).toBeNull();
  });
});
