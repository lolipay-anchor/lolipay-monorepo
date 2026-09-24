import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdatePaymentMethodDto } from './update-payment-method.dto';
import {
  PAYMENT_METHOD_LABEL_BAD_CHARS_MESSAGE,
  PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE,
  PAYMENT_METHOD_LABEL_TOO_LONG_MESSAGE,
} from './payment-method-label.validators';
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

  it.each(DANGEROUS_CONTROL_OR_FORMAT_CODE_POINTS)('refuses a label carrying %s, with the bad-characters sentence', (_label, codePoint) => {
    expect(labelProblems(`BCA${codePoint}`)).toContain(PAYMENT_METHOD_LABEL_BAD_CHARS_MESSAGE);
  });

  it.each(WIDENED_BAD_CODE_POINTS)('refuses a label carrying %s, with the bad-characters sentence', (_label, codePoint) => {
    expect(labelProblems(`BCA${codePoint}`)).toContain(PAYMENT_METHOD_LABEL_BAD_CHARS_MESSAGE);
  });

  it.each<[string, string]>([
    ['three ASCII spaces (U+0020)', '   '],
    ['three NBSP (U+00A0)', '   '],
    ['two ideographic spaces (U+3000)', '　　'],
  ])('refuses a whitespace-only label: %s', (_name, label) => {
    expect(labelProblems(label)).not.toEqual([]);
  });

  it.each(['.', '-', '123', '...', 'B', '1B2'])(
    'refuses %j, which does not contain a readable institution name',
    (label) => {
      expect(labelProblems(label)).toContain(PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE);
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

  it('rejects a label whose class-validator length undercounts a base-plus-variation-selector pair', () => {
    const label = `${'B'.repeat(63)}❤️`;
    expect(label.length).toBe(65);
    expect(labelProblems(label)).toContain(PAYMENT_METHOD_LABEL_TOO_LONG_MESSAGE);
  });

  it('rejects the exact heart-repeat measured against production — @MaxLength(64) alone would have accepted it, since validator.js collapses each presentation sequence to one, which is why length is enforced only by the code-point-accurate LENGTH_RE', () => {
    const label = '❤️'.repeat(64);
    expect(label.length).toBe(128);
    expect(labelProblems(label)).toContain(PAYMENT_METHOD_LABEL_TOO_LONG_MESSAGE);
  });

  it('rejects a label that only overflows 64 after NFC expansion — the length check sees the TRANSFORMED value, not the raw one', () => {
    const preNfc = '\u0958'.repeat(64);
    expect(preNfc.length).toBe(64);
    expect(preNfc.normalize('NFC').length).toBe(128);
    expect(labelProblems(preNfc)).toContain(PAYMENT_METHOD_LABEL_TOO_LONG_MESSAGE);
  });

  it('a label failing BOTH the length rule and the readable-name rule shows BOTH sentences, not just one — the constraint-key collision this DTO used to have with three @Matches under one "matches" key', () => {
    const label = '1'.repeat(70);
    const problems = labelProblems(label);
    expect(problems).toContain(PAYMENT_METHOD_LABEL_TOO_LONG_MESSAGE);
    expect(problems).toContain(PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE);
  });

  it('99,000 leading spaces then a real institution name is truncated before it is trimmed, so it reads as a missing name rather than a too-long label — a documented pathological edge, not a defect', () => {
    const pathological = `${' '.repeat(99_000)}BCA`;
    const problems = labelProblems(pathological);
    expect(problems).toContain(PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE);
    expect(problems).not.toContain(PAYMENT_METHOD_LABEL_TOO_LONG_MESSAGE);
  });
});
