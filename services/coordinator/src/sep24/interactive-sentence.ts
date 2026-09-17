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
  'No provider can take an order of this size right now. It is not anything you did. ' +
  'A smaller amount may go through — otherwise, come back to this page later.';

export const IDENTITY_REFUSED_SENTENCE =
  'This anchor has refused this identity, and that decision does not change. ' +
  'Sending your details here again will not reopen it, so there is nothing to wait for.';

export function withOwnSentence<E extends HttpException>(exception: E): E {
  return withInteractiveSentence(exception, exception.message);
}
