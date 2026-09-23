import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdatePaymentMethodDto } from './update-payment-method.dto';
import { DANGEROUS_CONTROL_OR_FORMAT_CODE_POINTS, WIDENED_BAD_CODE_POINTS } from '../../order/test-helpers';

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

describe('UpdatePaymentMethodDto.label is trimmed, NFC-normalized, and must contain a readable institution name, and only when label is patched', () => {
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

  it.each(['   ', '   ', '　　'])(
    'refuses a whitespace-only label %j',
    (label) => {
      expect(labelProblems(label)).not.toEqual([]);
    },
  );

  it.each(['.', '-', '123', 'B', '1B2'])(
    'refuses %j, which does not contain a readable institution name',
    (label) => {
      expect(labelProblems(label)).not.toEqual([]);
    },
  );

  it('accepts BI, the two-letter floor for a readable institution name', () => {
    expect(labelProblems('BI')).toEqual([]);
  });

  it('trims surrounding whitespace before storing the label', () => {
    const instance = plainToInstance(UpdatePaymentMethodDto, { label: '  BCA  ' });
    expect(validateSync(instance)).toEqual([]);
    expect(instance.label).toBe('BCA');
  });

  it('refuses a leading TAB rather than trimming it away, since a bare control character is refused at any other position', () => {
    expect(labelProblems('\tBCA')).not.toEqual([]);
  });

  it('NFC-normalizes a decomposed combining-character sequence into its precomposed form', () => {
    const decomposed = 'éé';
    const instance = plainToInstance(UpdatePaymentMethodDto, { label: decomposed });
    expect(validateSync(instance)).toEqual([]);
    expect(instance.label).toBe(decomposed.normalize('NFC'));
  });

  it('rejects the exact heart-repeat measured against production, which class-validator MaxLength(64) alone accepts', () => {
    const label = '❤️'.repeat(64);
    expect(label.length).toBe(128);
    expect(labelProblems(label)).not.toEqual([]);
  });
});
