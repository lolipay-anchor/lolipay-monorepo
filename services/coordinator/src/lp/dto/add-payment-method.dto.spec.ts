import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AddPaymentMethodDto, RailEnum } from './add-payment-method.dto';

describe('AddPaymentMethodDto refuses a details value too short to be a real destination', () => {
  const problems = (details: string) =>
    validateSync(
      plainToInstance(AddPaymentMethodDto, { rail: RailEnum.BANK, label: 'BCA', details }),
    ).flatMap((e) => Object.values(e.constraints ?? {}));

  it('refuses an empty string', () => {
    expect(problems('')).not.toEqual([]);
  });

  it('refuses a string of only whitespace', () => {
    expect(problems('      ')).not.toEqual([]);
  });

  it('refuses control-whitespace padding with no real content', () => {
    expect(problems('\t\n')).not.toEqual([]);
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

  it('accepts a real-looking bank destination', () => {
    expect(problems('BCA 1234567890 a/n Lolipay Provider')).toEqual([]);
  });
});
