export const PAYMENT_DETAILS_MIN_NON_WS_RE = /^(?:\s*\S){6}/

export const PAYMENT_DETAILS_MIN_NON_WS_MESSAGE =
  'details must contain at least 6 non-whitespace characters — enter a real payment destination'

export const PAYMENT_DETAILS_BAD_CHARS_MESSAGE =
  'those bank details contain characters this anchor will not send on'

const BAD_CHARS_RE = /[\p{Cc}\p{Cf}]/u

export function paymentDetailsError(raw: string): string | null {
  if (BAD_CHARS_RE.test(raw)) return PAYMENT_DETAILS_BAD_CHARS_MESSAGE
  if (!PAYMENT_DETAILS_MIN_NON_WS_RE.test(raw)) return PAYMENT_DETAILS_MIN_NON_WS_MESSAGE
  return null
}
