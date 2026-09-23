import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateLpMeDto } from './update-lp-me.dto';

describe('UpdateLpMeDto — the provider\'s own alert address, PATCH /lp/me (ADR 0054)', () => {
  const problems = (alertEmail: unknown) =>
    validateSync(plainToInstance(UpdateLpMeDto, { alertEmail })).flatMap((e) => Object.values(e.constraints ?? {}));

  it('accepts a plain address', () => {
    expect(problems('ops@example.com')).toEqual([]);
  });

  it('refuses an address containing whitespace', () => {
    expect(problems('ops @example.com')).not.toEqual([]);
  });

  it('refuses an address containing a control character', () => {
    expect(problems(`ops@example.com${String.fromCharCode(7)}`)).not.toEqual([]);
  });

  it('refuses an address longer than 254 characters', () => {
    const tooLong = `${'a'.repeat(250)}@a.co`;
    expect(tooLong).toHaveLength(255);
    expect(problems(tooLong)).not.toEqual([]);
  });
});
