import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AddPaymentMethodDto, RailEnum } from './add-payment-method.dto';
import { DANGEROUS_CONTROL_OR_FORMAT_CODE_POINTS, WIDENED_BAD_CODE_POINTS } from '../../order/payment-destination.spec';

describe('AddPaymentMethodDto enforces structural validity only — content is validated at the LpService chokepoint', () => {
  const problems = (details: string) =>
    validateSync(
      plainToInstance(AddPaymentMethodDto, { rail: RailEnum.BANK, label: 'BCA', details }),
    ).flatMap((e) => Object.values(e.constraints ?? {}));

  it('refuses an empty string', () => {
    expect(problems('')).not.toEqual([]);
  });

  it('refuses a destination longer than 500 characters', () => {
    expect(problems('B'.repeat(501))).not.toEqual([]);
  });

  it('accepts a string of only whitespace at the DTO layer — the service chokepoint refuses it', () => {
    expect(problems('      ')).toEqual([]);
  });

  it('accepts a bare three-digit placeholder at the DTO layer — the service chokepoint refuses it', () => {
    expect(problems('123')).toEqual([]);
  });

  it('accepts a real-looking bank destination', () => {
    expect(problems('BCA 1234567890 a/n Lolipay Provider')).toEqual([]);
  });
});

describe('AddPaymentMethodDto.label rejects control and format characters directly, never through checkPaymentDestination', () => {
  const labelProblems = (label: unknown) =>
    validateSync(
      plainToInstance(AddPaymentMethodDto, { rail: RailEnum.BANK, label, details: 'BCA 1234567890' }),
    ).flatMap((e) => Object.values(e.constraints ?? {}));

  it.each(['BCA', 'bca', 'BNI', 'OVO', 'GoPay', 'DANA', 'Mandiri'])(
    'accepts the short institution name %s, which the destination chokepoint would have refused as too_short',
    (label) => {
      expect(labelProblems(label)).toEqual([]);
    },
  );

  it('refuses an empty label', () => {
    expect(labelProblems('')).not.toEqual([]);
  });

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

  it('does not reject a real character outside the BMP, such as an emoji', () => {
    expect(labelProblems(`BCA${String.fromCodePoint(0x1f600)}`)).toEqual([]);
  });
});
