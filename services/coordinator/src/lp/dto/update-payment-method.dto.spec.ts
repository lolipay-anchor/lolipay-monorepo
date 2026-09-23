import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdatePaymentMethodDto } from './update-payment-method.dto';
import { DANGEROUS_CONTROL_OR_FORMAT_CODE_POINTS, WIDENED_BAD_CODE_POINTS } from '../../order/payment-destination.spec';

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

describe('UpdatePaymentMethodDto.label rejects control and format characters directly, and only when label is patched', () => {
  const labelProblems = (label: unknown) =>
    validateSync(plainToInstance(UpdatePaymentMethodDto, { label })).flatMap((e) =>
      Object.values(e.constraints ?? {}),
    );

  it('does not require label at all — a patch that omits it stays valid', () => {
    expect(
      validateSync(plainToInstance(UpdatePaymentMethodDto, { active: true })).flatMap((e) =>
        Object.values(e.constraints ?? {}),
      ),
    ).toEqual([]);
  });

  it.each(['BCA', 'bca', 'BNI', 'OVO', 'GoPay', 'DANA', 'Mandiri'])(
    'accepts the short institution name %s',
    (label) => {
      expect(labelProblems(label)).toEqual([]);
    },
  );

  it('refuses a label longer than 64 characters', () => {
    expect(labelProblems('B'.repeat(65))).not.toEqual([]);
  });

  it('accepts exactly 64 characters', () => {
    expect(labelProblems('B'.repeat(64))).toEqual([]);
  });

  it.each(DANGEROUS_CONTROL_OR_FORMAT_CODE_POINTS)('refuses a label carrying %s', (_label, codePoint) => {
    expect(labelProblems(`BCA${codePoint}`)).not.toEqual([]);
  });

  it.each(WIDENED_BAD_CODE_POINTS)('refuses a label carrying %s', (_label, codePoint) => {
    expect(labelProblems(`BCA${codePoint}`)).not.toEqual([]);
  });
});
