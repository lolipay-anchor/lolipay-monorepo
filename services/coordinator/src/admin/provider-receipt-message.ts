import { InternalServerErrorException } from '@nestjs/common';

export const PROVIDER_SERVER_ERROR =
  'Confirming this payment ran into an error. Try again: a payment is never recorded on chain twice, so if the first attempt did go through, the release continues from there.';

const STATEMENT =
  'I confirm I received the full payment for this order, and I authorize lolipay to mark this order as paid on chain.';

const PRINTABLE_TOKEN = /^[A-Za-z0-9-]+$/;

export interface ReceiptFields {
  id: string;
  tradeId: string;
  fiatAmount: bigint;
  fiatCurrency: string;
  ref: string | null;
}

export interface SignedReceipt {
  message: string;
  signature: string;
  receivedAt: Date;
}

export function providerReceiptMessage(order: ReceiptFields, at: number): string {
  const reference = order.ref ?? '-';
  if (![order.id, order.tradeId, order.fiatCurrency, reference].every((token) => PRINTABLE_TOKEN.test(token))) {
    throw new InternalServerErrorException(PROVIDER_SERVER_ERROR);
  }
  return `lolipay-confirm-receipt:v1 ${STATEMENT} order=${order.id} trade=${order.tradeId} amount=${order.fiatAmount} currency=${order.fiatCurrency} reference=${reference} at=${at}`;
}
