import { readFileSync } from 'fs';
import { join } from 'path';
import { describeContractError } from './contract-error';

describe('describeContractError', () => {
  it('names the deadline rejection rather than blaming the RPC', () => {
    const d = describeContractError(new Error('prepareTransaction failed: HostError: Error(Contract, #8)'));
    expect(d).toMatch(/deadlines/);
    expect(d).toMatch(/payWindowSecs/);
  });

  it('names the fee mismatch, which is the other way an admin can brick funding', () => {
    expect(describeContractError(new Error('Error(Contract, #7)'))).toMatch(/fee configuration/);
  });

  it('reports an unknown contract code without pretending to know it', () => {
    expect(describeContractError(new Error('Error(Contract, #99)'))).toMatch(/error #99/);
  });

  it('returns null for a genuine transport failure, so those still read as RPC problems', () => {
    expect(describeContractError(new Error('prepareTransaction failed: RPC timeout'))).toBeNull();
    expect(describeContractError(new Error('connection refused'))).toBeNull();
    expect(describeContractError('fetch failed')).toBeNull();
  });
});

describe('every escrow error the contract can raise has a sentence', () => {
  it('maps each code declared in contracts/escrow/src/types.rs, so a new contract error never reaches a user as a bare number', () => {
    const rust = readFileSync(join(__dirname, '../../../../contracts/escrow/src/types.rs'), 'utf8');
    const afterOpen = rust.slice(rust.indexOf('pub enum Error {') + 'pub enum Error {'.length);
    const enumBody = afterOpen.slice(0, afterOpen.indexOf('}'));
    const variantLines = enumBody.split('\n').filter((l) => l.trim().length > 0);
    const codes = [...enumBody.matchAll(/^\s+(\w+) = (\d+),?\s*$/gm)].map((m) => ({ name: m[1], code: Number(m[2]) }));
    expect(codes.length).toBe(variantLines.length);
    expect(codes.length).toBeGreaterThanOrEqual(21);
    const unmapped = codes.filter(({ code }) =>
      describeContractError(new Error(`Error(Contract, #${code})`))?.startsWith('the escrow contract rejected this call'),
    );
    expect(unmapped).toEqual([]);
  });

  it.each([
    [18, /window to (raise|open) a dispute/i],
    [19, /already been resolved/i],
    [20, /early release applies only to top-up trades/i],
    [21, /dispute (cannot|can no longer) be raised/i],
  ])('says in words what code %i means at the moment a user meets it', (code, sentence) => {
    expect(describeContractError(new Error(`HostError: Error(Contract, #${code})`))).toMatch(sentence);
  });
});
