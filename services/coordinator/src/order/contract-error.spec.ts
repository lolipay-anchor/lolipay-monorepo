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
