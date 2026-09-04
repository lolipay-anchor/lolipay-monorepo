import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateConfigDto } from './update-config.dto';
import { MIN_USABLE_PAY_WINDOW_SECS } from '../../config/contract-limits';

describe('the admin config DTO refuses a pay window the contract would let nobody sign inside', () => {
  const problems = (payWindowSecs: number) =>
    validateSync(plainToInstance(UpdateConfigDto, { payWindowSecs })).flatMap((e) => Object.values(e.constraints ?? {}));

  it('refuses the contract floor itself, because at creation time it leaves zero seconds to sign', () => {
    expect(problems(600).join(' ')).toMatch(new RegExp(String(MIN_USABLE_PAY_WINDOW_SECS)));
  });

  it('accepts the usable floor', () => {
    expect(problems(MIN_USABLE_PAY_WINDOW_SECS)).toEqual([]);
  });
});
