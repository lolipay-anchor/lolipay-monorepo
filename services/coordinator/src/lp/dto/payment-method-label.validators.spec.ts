import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AddPaymentMethodDto, RailEnum } from './add-payment-method.dto';
import { UpdatePaymentMethodDto } from './update-payment-method.dto';
import { PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE } from './payment-method-label.validators';

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
])('%s.label refuses an account-number-shaped or phone-number-shaped label at the write door', (_dto, labelProblems) => {
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
});
