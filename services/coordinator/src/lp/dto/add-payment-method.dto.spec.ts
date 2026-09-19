import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AddPaymentMethodDto, RailEnum } from './add-payment-method.dto';

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
