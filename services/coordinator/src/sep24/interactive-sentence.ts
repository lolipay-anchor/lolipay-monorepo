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
  'This anchor could not match a provider to this order right now. ' +
  'It is not anything you did, and no money has moved. ' +
  'You can go back and try again, or come back to this page later.';

export const LP_CAPACITY_LOST_SENTENCE =
  'The provider this anchor matched you with no longer has room for this order. ' +
  'Nothing you entered was wrong and no money has moved. ' +
  'Go back and submit again — this anchor will look for another provider.';

export const IDENTITY_REFUSED_SENTENCE =
  'This anchor has refused this identity, and that decision does not change. ' +
  'Sending your details here again will not reopen it, so there is nothing to wait for.';

export function withOwnSentence<E extends HttpException>(exception: E): E {
  return withInteractiveSentence(exception, exception.message);
}
