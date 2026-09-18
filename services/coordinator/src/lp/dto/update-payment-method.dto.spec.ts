import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdatePaymentMethodDto } from './update-payment-method.dto';

describe('UpdatePaymentMethodDto refuses a details value too short to be a real destination, when details is patched at all', () => {
  const problems = (details: string) =>
    validateSync(plainToInstance(UpdatePaymentMethodDto, { details })).flatMap((e) =>
      Object.values(e.constraints ?? {}),
    );

  it('refuses an empty string', () => {
    expect(problems('')).not.toEqual([]);
  });

  it('refuses a bare three-digit placeholder', () => {
    expect(problems('123')).not.toEqual([]);
  });

  it('refuses five non-whitespace characters padded with spaces', () => {
    expect(problems('BCA 1')).not.toEqual([]);
  });

  it('accepts exactly six non-whitespace characters', () => {
    expect(problems('BCA 555555')).toEqual([]);
  });

  it('does not require details at all — a patch that omits it stays valid', () => {
    expect(
      validateSync(plainToInstance(UpdatePaymentMethodDto, { active: true })).flatMap((e) =>
        Object.values(e.constraints ?? {}),
      ),
    ).toEqual([]);
  });
});
