export const PAYMENT_DESTINATION_MAX_LEN = 500;
export const PAYMENT_DESTINATION_MIN_WORD_CHARS = 6;

const PAYMENT_DESTINATION_BAD_CHARS_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
export const NO_CONTROL_OR_FORMAT_CHARS_RE = /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]*$/u;

export const PAYMENT_METHOD_LABEL_MAX_LEN = 64;
export const PAYMENT_METHOD_LABEL_LENGTH_RE = new RegExp(
  `^[\\s\\S]{0,${PAYMENT_METHOD_LABEL_MAX_LEN}}$`,
  'u',
);
export const PAYMENT_METHOD_LABEL_HAS_LETTERS_RE = /\p{L}[^\p{L}]*\p{L}/u;
export const PAYMENT_METHOD_LABEL_DIGIT_RE = /[\p{Nd}\p{No}]/gu;
export const PAYMENT_METHOD_LABEL_MAX_DIGITS = 5;

export const PAYMENT_METHOD_LABEL_BAD_CHARS_RE =
  /^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}.!?;:–—―]*$/u;

const LABEL_EDGE_WHITESPACE_RE = /^\p{Zs}+|\p{Zs}+$/gu;

export const PAYMENT_METHOD_LABEL_COST_CEILING = 1024;

function boundToCostCeiling(value: string): string {
  return value.length > PAYMENT_METHOD_LABEL_COST_CEILING
    ? value.slice(0, PAYMENT_METHOD_LABEL_COST_CEILING)
    : value;
}

export function normalizePaymentMethodLabel(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value.length > PAYMENT_METHOD_LABEL_COST_CEILING) return boundToCostCeiling(value);
  return boundToCostCeiling(value.replace(LABEL_EDGE_WHITESPACE_RE, '').normalize('NFC'));
}

const STELLAR_SECRET_SEED_SHAPE_RE = /S[A-Z2-7]{55}/;

export const PAYMENT_DESTINATION_SECRET_KEY_SENTENCE =
  'Those details contain what looks like a Stellar secret key, so this anchor has not stored them and will not pass them on. ' +
  'Anyone holding that key controls the wallet, so treat it as compromised: create a new wallet and move your funds to it. ' +
  'Then enter the bank account the rupiah should go to, and nothing else.';

export type PaymentDestinationProblem =
  | 'missing'
  | 'too_long'
  | 'bad_chars'
  | 'secret_key'
  | 'too_short';

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
  if (STELLAR_SECRET_SEED_SHAPE_RE.test(trimmed)) {
    return { ok: false, problem: 'secret_key' };
  }
  const wordChars = trimmed.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (wordChars < PAYMENT_DESTINATION_MIN_WORD_CHARS) {
    return { ok: false, problem: 'too_short' };
  }
  return { ok: true, value: trimmed };
}
