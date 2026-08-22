import * as fs from 'fs';
import * as path from 'path';
import {
  MIN_PAY_WINDOW_SECS,
  MAX_PAY_WINDOW_SECS,
  MAX_TOTAL_WINDOW_SECS,
  windowsFitTheContract,
} from './contract-limits';

const LIB_RS = path.resolve(__dirname, '../../../../contracts/escrow/src/lib.rs');

function rustConst(name: string): number {
  const src = fs.readFileSync(LIB_RS, 'utf8');
  const m = src.match(new RegExp(`const ${name}: u64 = ([0-9_]+);`));
  if (!m) throw new Error(`could not find const ${name} in ${LIB_RS}`);
  return Number(m[1].replace(/_/g, ''));
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
