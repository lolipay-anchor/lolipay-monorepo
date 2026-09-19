export const PAYMENT_DESTINATION_MIN_WORD_CHARS = 6

export const PAYMENT_DESTINATION_TOO_SHORT_MESSAGE =
  'Those bank details are too short to pay into. ' +
  'Enter the bank name, the account number, and the name on the account.'

export const PAYMENT_DESTINATION_BAD_CHARS_MESSAGE =
  'those bank details contain characters this anchor will not send on'

const BAD_CHARS_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u
const WORD_CHAR_RE = /[\p{L}\p{N}]/gu

export function orderPaymentDestinationError(raw: string): string | null {
  const trimmed = raw.trim()
  if (BAD_CHARS_RE.test(trimmed)) return PAYMENT_DESTINATION_BAD_CHARS_MESSAGE
  const wordChars = trimmed.match(WORD_CHAR_RE)?.length ?? 0
  if (wordChars < PAYMENT_DESTINATION_MIN_WORD_CHARS) return PAYMENT_DESTINATION_TOO_SHORT_MESSAGE
  return null
}
