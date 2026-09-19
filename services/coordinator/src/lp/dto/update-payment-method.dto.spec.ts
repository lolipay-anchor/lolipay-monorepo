import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdatePaymentMethodDto } from './update-payment-method.dto';

describe('UpdatePaymentMethodDto enforces structural validity only — content is validated at the LpService chokepoint, and only when details is patched', () => {
  const problems = (details: string) =>
    validateSync(plainToInstance(UpdatePaymentMethodDto, { details })).flatMap((e) =>
      Object.values(e.constraints ?? {}),
    );

  it('refuses an empty string', () => {
    expect(problems('')).not.toEqual([]);
  });

  it('refuses a destination longer than 500 characters', () => {
    expect(problems('B'.repeat(501))).not.toEqual([]);
  });

  it('accepts a bare three-digit placeholder at the DTO layer — the service chokepoint refuses it', () => {
    expect(problems('123')).toEqual([]);
  });

  it('does not require details at all — a patch that omits it stays valid', () => {
    expect(
      validateSync(plainToInstance(UpdatePaymentMethodDto, { active: true })).flatMap((e) =>
        Object.values(e.constraints ?? {}),
      ),
    ).toEqual([]);
  });
});
