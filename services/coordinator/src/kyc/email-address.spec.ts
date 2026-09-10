import { isStorableEmailAddress, EMAIL_MAX_LENGTH } from './email-address';

describe('the address this anchor will store', () => {
  it('accepts an ordinary address', () => {
    expect(isStorableEmailAddress('budi.santoso@example.com')).toBe(true);
    expect(isStorableEmailAddress('x@y')).toBe(true);
  });

  it('refuses exactly what the database CHECK refuses, so a stored value can never raise a 500 instead of a refusal', () => {
    expect(isStorableEmailAddress('tezs')).toBe(false);
    expect(isStorableEmailAddress('a b@c.d')).toBe(false);
    expect(isStorableEmailAddress('a@b\nc')).toBe(false);
    expect(isStorableEmailAddress('@y')).toBe(false);
    expect(isStorableEmailAddress('x@')).toBe(false);
  });

  it('refuses beyond the column, because express accepts a 100 kB body and one route takes an unbounded Record', () => {
    expect(EMAIL_MAX_LENGTH).toBe(254);
    const atTheLimit = 'a'.repeat(EMAIL_MAX_LENGTH - 4) + '@b.c';
    expect(atTheLimit).toHaveLength(EMAIL_MAX_LENGTH);
    expect(isStorableEmailAddress(atTheLimit)).toBe(true);
    const oneOver = 'a'.repeat(EMAIL_MAX_LENGTH - 3) + '@b.c';
    expect(oneOver).toHaveLength(EMAIL_MAX_LENGTH + 1);
    expect(isStorableEmailAddress(oneOver)).toBe(false);
  });

  it('refuses absence rather than throwing on it', () => {
    expect(isStorableEmailAddress('')).toBe(false);
    expect(isStorableEmailAddress('   ')).toBe(false);
    expect(isStorableEmailAddress(undefined)).toBe(false);
  });
});
