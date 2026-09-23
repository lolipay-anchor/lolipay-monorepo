import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  ALERT_EMAIL_FORMAT_MESSAGE,
  ALERT_EMAIL_TOO_LONG_MESSAGE,
  ALERT_EMAIL_UNPRINTABLE_MESSAGE,
  UpdateLpMeDto,
} from './update-lp-me.dto';

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

  it('accepts null, so the provider can clear a previously-set address', () => {
    expect(problems(null)).toEqual([]);
  });

  it('does not tell a provider who sent the field ABSENT that an address they never sent is too long, badly-shaped or unprintable', () => {
    const wrongForAbsence = [ALERT_EMAIL_FORMAT_MESSAGE, ALERT_EMAIL_UNPRINTABLE_MESSAGE, ALERT_EMAIL_TOO_LONG_MESSAGE];
    const got = problems(undefined);
    for (const msg of wrongForAbsence) expect(got).not.toContain(msg);
  });
});
