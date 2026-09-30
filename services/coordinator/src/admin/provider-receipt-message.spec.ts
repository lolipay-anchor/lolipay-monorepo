import { InternalServerErrorException } from '@nestjs/common';
import { providerReceiptMessage } from './provider-receipt-message';

const SERVER_ERROR = 'Confirming this payment ran into an error. Try again: a payment is never recorded on chain twice, so if the first attempt did go through, the release continues from there.';
const ONE_LINE_OF_PRINTABLE_ASCII = /^[\x21-\x7E]+( [\x21-\x7E]+)*$/;

interface ReceiptFields {
  id: string;
  tradeId: string;
  fiatAmount: bigint;
  fiatCurrency: string;
  ref: string | null;
}

const ROW: ReceiptFields = {
  id: '3b2f6c1e-8a47-4d19-9c0e-5f1a2b7d9e40',
  tradeId: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  fiatAmount: 1500000n,
  fiatCurrency: 'IDR',
  ref: 'LP-7K2Q',
};
const AT = 1790000000;

const PRINTED: [string, ReceiptFields, string][] = [
  [
    'a fixed row',
    ROW,
    'lolipay-confirm-receipt:v1 I confirm I received the full payment for this order, and I authorize lolipay to mark this order as paid on chain. order=3b2f6c1e-8a47-4d19-9c0e-5f1a2b7d9e40 trade=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 amount=1500000 currency=IDR reference=LP-7K2Q at=1790000000',
  ],
  [
    'an order with no reference, as reference=- and never null, undefined or an empty value',
    { ...ROW, ref: null },
    'lolipay-confirm-receipt:v1 I confirm I received the full payment for this order, and I authorize lolipay to mark this order as paid on chain. order=3b2f6c1e-8a47-4d19-9c0e-5f1a2b7d9e40 trade=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 amount=1500000 currency=IDR reference=- at=1790000000',
  ],
  [
    'an amount past 2^53, as the BigInt\'s own digits, so a trip through Number shows as a changed last digit',
    { ...ROW, fiatAmount: 9007199254740993n },
    'lolipay-confirm-receipt:v1 I confirm I received the full payment for this order, and I authorize lolipay to mark this order as paid on chain. order=3b2f6c1e-8a47-4d19-9c0e-5f1a2b7d9e40 trade=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 amount=9007199254740993 currency=IDR reference=LP-7K2Q at=1790000000',
  ],
];

const UNPRINTABLE: [string, ReceiptFields][] = [
  ['id ends in a newline', { ...ROW, id: `${ROW.id}\n` }],
  ['trade id carries an equals sign', { ...ROW, tradeId: `${ROW.tradeId}=` }],
  ['currency carries a space', { ...ROW, fiatCurrency: 'ID R' }],
  ['reference carries an em dash', { ...ROW, ref: 'LP\u20147K2Q' }],
];

describe('providerReceiptMessage — the bytes a provider signs to confirm the rupiah arrived', () => {
  it.each(PRINTED)('M1 — prints the frozen v1 line, as one line of printable ASCII, for %s', (_label, order, expected) => {
    const printed = providerReceiptMessage(order, AT);

    expect(printed).toBe(expected);
    expect(printed).toMatch(ONE_LINE_OF_PRINTABLE_ASCII);
  });

  it.each(UNPRINTABLE)(
    'M1 — refuses to print an order whose %s, with an InternalServerErrorException carrying the provider\'s 5xx sentence, never a 401 or a 403',
    (_label, order) => {
      let thrown: unknown;
      try {
        providerReceiptMessage(order, AT);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(InternalServerErrorException);
      expect((thrown as InternalServerErrorException).getResponse()).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: SERVER_ERROR,
      });
    },
  );
});
