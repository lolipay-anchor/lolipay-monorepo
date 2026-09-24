import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AddPaymentMethodDto, RailEnum } from './add-payment-method.dto';
import { UpdatePaymentMethodDto } from './update-payment-method.dto';
import {
  PAYMENT_METHOD_LABEL_BAD_CHARS_MESSAGE,
  PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE,
} from './payment-method-label.validators';

function addLabelProblems(label: unknown): string[] {
  return validateSync(
    plainToInstance(AddPaymentMethodDto, { rail: RailEnum.BANK, label, details: 'BCA 1234567890' }),
  ).flatMap((e) => Object.values(e.constraints ?? {}));
}

function updateLabelProblems(label: unknown): string[] {
  return validateSync(plainToInstance(UpdatePaymentMethodDto, { label })).flatMap((e) =>
    Object.values(e.constraints ?? {}),
  );
}

describe.each<[string, (label: unknown) => string[]]>([
  ['AddPaymentMethodDto', addLabelProblems],
  ['UpdatePaymentMethodDto', updateLabelProblems],
])('%s.label refuses a label that is number-shaped in any digit form, or that can terminate lolipay\'s sentence and start its own, at the write door', (_dto, labelProblems) => {
  it('refuses the reported label, an institution name followed by a contiguous account number', () => {
    expect(labelProblems('Salah? kirim ke BRI 002501000123456')).toContain(
      PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE,
    );
  });

  it('refuses the same digits split into groups the way a bank statement prints them, never admitted merely because no single run reaches the floor', () => {
    expect(labelProblems('BRI 0025 0100 0123 456')).toContain(PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE);
  });

  it('refuses a label carrying a phone-number-length digit sequence', () => {
    expect(labelProblems('GoPay 08123456789')).toContain(PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE);
  });

  it.each(['bca', 'BCA', 'Mandiri', 'GoPay'])('still accepts the plain institution name %s', (label) => {
    expect(labelProblems(label)).toEqual([]);
  });

  it('accepts a short disambiguating digit an LP might add for a second account on the same rail', () => {
    expect(labelProblems('BCA 2')).toEqual([]);
  });

  it('accepts exactly five digits, one below the rejection floor', () => {
    expect(labelProblems('BCA 12345')).toEqual([]);
  });

  it('refuses exactly six digits, the rejection floor', () => {
    expect(labelProblems('BCA 123456')).toContain(PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE);
  });

  it('still accepts a label at exactly the 64-character ceiling made only of letters, unaffected by the digit floor', () => {
    expect(labelProblems('B'.repeat(64))).toEqual([]);
  });

  it('refuses an account number written in circled digits, which \\p{Nd} alone would have missed', () => {
    expect(labelProblems('BRI ⓪⓪②⑤⓪①⓪⓪⓪①②③④⑤⑥')).toContain(PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE);
  });

  it('refuses an account number written in superscript digits, which \\p{Nd} alone would have missed', () => {
    expect(labelProblems('BRI ⁰⁰²⁵⁰¹⁰⁰⁰¹²³⁴⁵⁶')).toContain(PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE);
  });

  it('still refuses an account number written in fullwidth digits, already \\p{Nd} before this change', () => {
    expect(labelProblems('ＢＲＩ ００２５０１０００１２３４５６')).toContain(PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE);
  });

  it.each<[string, string]>([
    ['a period', 'BCA. Kirim ke rekening lain'],
    ['an em dash', 'BCA — resmi lolipay'],
    ['a colon', 'BCA: transfer ke BRI ya'],
    ['an en dash', 'BCA – resmi lolipay'],
  ])("refuses %s, which would terminate lolipay's sentence and start its own", (_name, label) => {
    expect(labelProblems(label)).toContain(PAYMENT_METHOD_LABEL_BAD_CHARS_MESSAGE);
  });

  it.each<[string, string]>([
    ['a hyphen', 'BPD Jabar-Banten'],
    ['an ampersand', 'AT&T Bank'],
    ['an apostrophe', "People's Bank"],
    ['a comma', 'Bank Central Asia, Tbk'],
    ['parentheses', 'Bank Rakyat Indonesia (Persero) Tbk'],
  ])('still accepts a real institution name containing %s', (_name, label) => {
    expect(labelProblems(label)).toEqual([]);
  });
});
