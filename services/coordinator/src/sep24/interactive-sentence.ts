import type { HttpException } from '@nestjs/common';

const HELD = 'lolipayInteractiveSentence';

export function withInteractiveSentence<E extends HttpException>(exception: E, sentence: string): E {
  return Object.defineProperty(exception, HELD, { value: sentence });
}

export function interactiveSentenceOf(exception: unknown): string | undefined {
  const held = (exception as Record<string, unknown> | null | undefined)?.[HELD];
  return typeof held === 'string' ? held : undefined;
}

export const NO_PROVIDER_SENTENCE =
  'This anchor could not match a provider to this order right now, and no money has moved. ' +
  'You can go back and try again, or come back later.';

export const PAYMENT_DESTINATION_MISSING_SENTENCE =
  'name the bank account this anchor should pay the rupiah into';

export const PAYMENT_DESTINATION_TOO_LONG_SENTENCE = 'those bank details are too long';

export const PAYMENT_DESTINATION_BAD_CHARS_SENTENCE =
  'those bank details contain characters this anchor will not send on';

export const PAYMENT_DESTINATION_TOO_SHORT_SENTENCE =
  'Those bank details are too short to pay into. ' +
  'Enter the bank name, the account number, and the name on the account.';

export const LP_CAPACITY_LOST_SENTENCE =
  'The provider this anchor matched you with no longer has room for this order. ' +
  'Nothing you entered was wrong and no money has moved. ' +
  'Go back and submit again — this anchor will look for another provider.';

export const CLAIM_HAS_NO_PROVIDER_TO_NOTIFY_SENTENCE =
  'This anchor could not pass your message to the provider, so it has not recorded that you sent the rupiah — ' +
  'and nothing you change here will get past that. Nothing else on this deposit has changed, and nothing has been ' +
  'taken from you by this anchor. If you have already sent the rupiah, do not send it a second time and do not ' +
  'start a new deposit: keep your transfer receipt and the reference shown on this page. This deposit still runs ' +
  'to its own deadline, after which the escrow can be returned to the provider and it closes.';

export const IDENTITY_REFUSED_SENTENCE =
  'This anchor has refused this identity, and that decision does not change. ' +
  'Sending your details here again will not reopen it, so there is nothing to wait for.';

export function withOwnSentence<E extends HttpException>(exception: E): E {
  return withInteractiveSentence(exception, exception.message);
}
