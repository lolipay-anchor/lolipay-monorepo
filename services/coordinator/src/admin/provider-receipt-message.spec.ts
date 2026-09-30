import { providerReceiptMessage } from './provider-receipt-message';

const ROW = {
  id: '3b2f6c1e-8a47-4d19-9c0e-5f1a2b7d9e40',
  tradeId: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  fiatAmount: 1500000n,
  fiatCurrency: 'IDR',
  ref: 'LP-7K2Q',
};
const AT = 1790000000;

describe('providerReceiptMessage — the bytes a provider signs to confirm the rupiah arrived', () => {
  it('M1 — prints the frozen v1 line for a fixed row, so a changed tag, sentence, token order, separator or amount encoding, or a dropped field, shows here first', () => {
    expect(providerReceiptMessage(ROW, AT)).toBe(
      'lolipay-confirm-receipt:v1 I confirm I received the payment for this order. order=3b2f6c1e-8a47-4d19-9c0e-5f1a2b7d9e40 trade=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 amount=1500000 currency=IDR reference=LP-7K2Q at=1790000000',
    );
  });

  it('M1 — prints reference=- for an order that has no reference, never null, undefined or an empty value', () => {
    expect(providerReceiptMessage({ ...ROW, ref: null }, AT)).toBe(
      'lolipay-confirm-receipt:v1 I confirm I received the payment for this order. order=3b2f6c1e-8a47-4d19-9c0e-5f1a2b7d9e40 trade=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 amount=1500000 currency=IDR reference=- at=1790000000',
    );
  });

  it('M1 — prints the amount as the BigInt\'s own base-10 digits even past 2^53, so a trip through Number shows as a changed last digit', () => {
    expect(providerReceiptMessage({ ...ROW, fiatAmount: 9007199254740993n }, AT)).toBe(
      'lolipay-confirm-receipt:v1 I confirm I received the payment for this order. order=3b2f6c1e-8a47-4d19-9c0e-5f1a2b7d9e40 trade=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 amount=9007199254740993 currency=IDR reference=LP-7K2Q at=1790000000',
    );
  });
});
