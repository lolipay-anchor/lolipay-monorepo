export const PAYMENT_DESTINATION_MAX_LEN = 500;
export const PAYMENT_DESTINATION_MIN_WORD_CHARS = 6;

const PAYMENT_DESTINATION_BAD_CHARS_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
export const NO_CONTROL_OR_FORMAT_CHARS_RE = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]*$/u;

export type PaymentDestinationProblem = 'missing' | 'too_long' | 'bad_chars' | 'too_short';

export type PaymentDestinationCheck =
  | { ok: true; value: string }
  | { ok: false; problem: PaymentDestinationProblem };

export function checkPaymentDestination(raw: unknown): PaymentDestinationCheck {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, problem: 'missing' };
  }
  const trimmed = raw.trim();
  if (trimmed.length > PAYMENT_DESTINATION_MAX_LEN) {
    return { ok: false, problem: 'too_long' };
  }
  if (PAYMENT_DESTINATION_BAD_CHARS_RE.test(trimmed)) {
    return { ok: false, problem: 'bad_chars' };
  }
  const wordChars = trimmed.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (wordChars < PAYMENT_DESTINATION_MIN_WORD_CHARS) {
    return { ok: false, problem: 'too_short' };
  }
  return { ok: true, value: trimmed };
}
