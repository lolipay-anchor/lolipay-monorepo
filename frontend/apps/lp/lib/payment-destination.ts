export const PAYMENT_DETAILS_MIN_WORD_CHARS = 6

export const PAYMENT_DETAILS_TOO_SHORT_MESSAGE =
  'Those payment details are too short for anyone to pay into. ' +
  'Enter the full destination and the name it belongs to.'

export const PAYMENT_DETAILS_BAD_CHARS_MESSAGE =
  'Those payment details contain characters this anchor cannot pass on to a depositor. ' +
  'Type the destination in by hand rather than pasting it.'

const BAD_CHARS_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u
const WORD_CHAR_RE = /[\p{L}\p{N}]/gu

export function paymentDetailsError(raw: string): string | null {
  const trimmed = raw.trim()
  if (BAD_CHARS_RE.test(trimmed)) return PAYMENT_DETAILS_BAD_CHARS_MESSAGE
  const wordChars = trimmed.match(WORD_CHAR_RE)?.length ?? 0
  if (wordChars < PAYMENT_DETAILS_MIN_WORD_CHARS) return PAYMENT_DETAILS_TOO_SHORT_MESSAGE
  return null
}
