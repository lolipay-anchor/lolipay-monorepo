import {
  PAYMENT_DESTINATION_BAD_CHARS_SENTENCE,
  PAYMENT_DESTINATION_MISSING_SENTENCE,
  PAYMENT_DESTINATION_TOO_LONG_SENTENCE,
  PAYMENT_DESTINATION_TOO_SHORT_SENTENCE,
} from '../sep24/interactive-sentence';
import { validatePaymentDestination } from './order.service';
import {
  checkPaymentDestination,
  NO_CONTROL_OR_FORMAT_CHARS_RE,
  normalizePaymentMethodLabel,
  PAYMENT_METHOD_LABEL_COST_CEILING,
  PAYMENT_METHOD_LABEL_DIGIT_RE,
  PAYMENT_METHOD_LABEL_HAS_LETTERS_RE,
  PAYMENT_METHOD_LABEL_MAX_DIGITS,
  PAYMENT_METHOD_LABEL_MAX_LEN,
} from './payment-destination';
import { DANGEROUS_CONTROL_OR_FORMAT_CODE_POINTS, WIDENED_BAD_CODE_POINTS } from './test-helpers';

describe('validatePaymentDestination trims and returns a well-formed destination', () => {
  it('trims surrounding whitespace and returns the trimmed value', () => {
    expect(validatePaymentDestination('  BNI 999  ')).toBe('BNI 999');
  });

  it.each(['BNI 999', 'BCA 001', 'BCA 123'])(
    'accepts %s, an existing e2e fixture with exactly six word characters',
    (raw) => {
      expect(validatePaymentDestination(raw)).toBe(raw);
    },
  );

  it('accepts exactly 500 characters after trimming', () => {
    const raw = 'B'.repeat(500);
    expect(validatePaymentDestination(raw)).toBe(raw);
  });
});

describe('validatePaymentDestination refuses a missing destination', () => {
  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['a number', 200000],
    ['an array', ['BCA 1', 'BCA 2']],
    ['an object', { toString: 'x' }],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
  ])('refuses %s', (_label, raw) => {
    expect(() => validatePaymentDestination(raw)).toThrow(PAYMENT_DESTINATION_MISSING_SENTENCE);
  });
});

describe('validatePaymentDestination enforces the six-word-character floor', () => {
  it('refuses five word characters as too short', () => {
    expect(() => validatePaymentDestination('BNI 99')).toThrow(PAYMENT_DESTINATION_TOO_SHORT_SENTENCE);
  });

  it('does not count punctuation toward the floor, unlike the regex it replaces', () => {
    expect(() => validatePaymentDestination('------')).toThrow(PAYMENT_DESTINATION_TOO_SHORT_SENTENCE);
  });

  it('does not count underscores as word characters, unlike \\w', () => {
    expect(() => validatePaymentDestination('______')).toThrow(PAYMENT_DESTINATION_TOO_SHORT_SENTENCE);
  });

  it('the floor stays at six, so a fixture with exactly six passes and one with five does not', () => {
    expect(validatePaymentDestination('BNI99X')).toBe('BNI99X');
    expect(() => validatePaymentDestination('BNI9X')).toThrow(PAYMENT_DESTINATION_TOO_SHORT_SENTENCE);
  });
});

describe('validatePaymentDestination refuses length and format violations', () => {
  it('refuses a destination longer than 500 characters after trimming', () => {
    expect(() => validatePaymentDestination(`  ${'B'.repeat(501)}  `)).toThrow(
      PAYMENT_DESTINATION_TOO_LONG_SENTENCE,
    );
  });

  it.each(DANGEROUS_CONTROL_OR_FORMAT_CODE_POINTS)(
    'refuses a destination carrying %s, which the old LP regex /^(?:\\s*\\S){6}/ would have admitted',
    (_label, codePoint) => {
      expect(() => validatePaymentDestination(`BCA 123${codePoint}456`)).toThrow(
        PAYMENT_DESTINATION_BAD_CHARS_SENTENCE,
      );
      expect(/^(?:\s*\S){6}/.test(`X${codePoint}XXXXX`)).toBe(true);
    },
  );

  it.each(WIDENED_BAD_CODE_POINTS)(
    "refuses a destination carrying %s, which /[\\p{Cc}\\p{Cf}]/u alone would have admitted",
    (_label, codePoint) => {
      expect(() => validatePaymentDestination(`BCA 123${codePoint}456`)).toThrow(
        PAYMENT_DESTINATION_BAD_CHARS_SENTENCE,
      );
    },
  );

  it("does not reject a real character outside the BMP, such as an emoji", () => {
    const withEmoji = `BCA 123${String.fromCodePoint(0x1f600)}456`;
    expect(validatePaymentDestination(withEmoji)).toBe(withEmoji);
  });
});

describe('PAYMENT_METHOD_LABEL_HAS_LETTERS_RE requires at least two letters and stays linear-time', () => {
  it('refuses zero or one letter', () => {
    expect(PAYMENT_METHOD_LABEL_HAS_LETTERS_RE.test('')).toBe(false);
    expect(PAYMENT_METHOD_LABEL_HAS_LETTERS_RE.test('1')).toBe(false);
    expect(PAYMENT_METHOD_LABEL_HAS_LETTERS_RE.test('B')).toBe(false);
    expect(PAYMENT_METHOD_LABEL_HAS_LETTERS_RE.test('1' + 'B')).toBe(false);
  });

  it.each([2, 4, 8, 16])('accepts a run of exactly %i letters', (n) => {
    expect(PAYMENT_METHOD_LABEL_HAS_LETTERS_RE.test('B'.repeat(n))).toBe(true);
  });

  it('accepts two letters separated by any run of non-letters', () => {
    expect(PAYMENT_METHOD_LABEL_HAS_LETTERS_RE.test('B' + '1'.repeat(500) + 'I')).toBe(true);
  });

  it.each([8_000, 16_000, 50_000, 99_000])(
    'classifies a %i-character adversarial string (no letters at all) in well under 50ms, never the quadratic blowup of the anchor-free nested-quantifier regex it replaced',
    (n) => {
      const adversarial = '1'.repeat(n);
      const start = performance.now();
      const result = PAYMENT_METHOD_LABEL_HAS_LETTERS_RE.test(adversarial);
      const elapsedMs = performance.now() - start;
      expect(result).toBe(false);
      expect(elapsedMs).toBeLessThan(50);
    },
  );
});

describe('PAYMENT_METHOD_LABEL_DIGIT_RE counts every digit in a label, not just the longest contiguous run', () => {
  it('counts digits split across several groups the way a bank statement prints an account number', () => {
    expect(('0025 0100 0123 456'.match(PAYMENT_METHOD_LABEL_DIGIT_RE) ?? []).length).toBe(15);
  });

  it('counts a non-ASCII decimal-digit script the same as ASCII digits', () => {
    expect(('٠١٢٣٤٥'.match(PAYMENT_METHOD_LABEL_DIGIT_RE) ?? []).length).toBe(6);
  });

  it('counts zero digits in a plain institution name', () => {
    expect(('Bank Mandiri'.match(PAYMENT_METHOD_LABEL_DIGIT_RE) ?? []).length).toBe(0);
  });

  it('PAYMENT_METHOD_LABEL_MAX_DIGITS sits below the shortest real Indonesian phone or bank account number', () => {
    expect(PAYMENT_METHOD_LABEL_MAX_DIGITS).toBeLessThan(10);
  });
});

describe('normalizePaymentMethodLabel bounds its OUTPUT at PAYMENT_METHOD_LABEL_COST_CEILING before any regex runs, regardless of shape', () => {
  it.each<[string, string]>([
    ['99,000 digits, no whitespace at all', '1'.repeat(99_000)],
    ['a non-space character, 99,000 spaces, then a non-space character', `x${' '.repeat(99_000)}x`],
    ['99,000 characters of a code point that would DOUBLE under NFC — over the raw ceiling, so NFC never runs on it', 'क़'.repeat(99_000)],
    ['1,024 characters of a code point that EXPANDS UP TO 3× under NFC — at the raw ceiling, so NFC does run', '\uFB2C'.repeat(1024)],
  ])('never returns more than PAYMENT_METHOD_LABEL_COST_CEILING characters for %s', (_label, raw) => {
    const result = normalizePaymentMethodLabel(raw) as string;
    expect(result.length).toBeLessThanOrEqual(PAYMENT_METHOD_LABEL_COST_CEILING);
  });

  it('passes a short, well-formed label through unchanged', () => {
    expect(normalizePaymentMethodLabel('BCA')).toBe('BCA');
  });

  it('the 3× fixture above really does expand past the ceiling under NFC before the second bound clips it back', () => {
    expect('\uFB2C'.repeat(1024).normalize('NFC').length).toBe(3072);
  });
});

describe('normalizePaymentMethodLabel does not silently trade one real institution name for another when leading whitespace pushes the raw input over the cost ceiling', () => {
  it.each<[string, string, string]>([
    ['BCA Digital', ' '.repeat(1014) + 'BCA Digital', 'BCA Digita'],
    ['BCA Digital', ' '.repeat(1020) + 'BCA Digital', 'BCA'],
    ['Bank Mandiri Syariah', ' '.repeat(1005) + 'Bank Mandiri Syariah', 'Bank Mandiri Syaria'],
  ])('never turns %s into another real institution name such as %j merely because it was pushed over the ceiling', (_label, raw, previouslyProducedWrongBank) => {
    const result = normalizePaymentMethodLabel(raw) as string;
    expect(result).not.toBe(previouslyProducedWrongBank);
    expect(result.length).toBe(PAYMENT_METHOD_LABEL_COST_CEILING);
  });

  it('trimming still runs at exactly the ceiling — the raw ceiling is not over it', () => {
    expect(normalizePaymentMethodLabel(`${' '.repeat(PAYMENT_METHOD_LABEL_COST_CEILING - 3)}BCA`)).toBe('BCA');
  });

  it('one character over the ceiling stops trimming entirely, rather than trimming the truncated tail', () => {
    expect(normalizePaymentMethodLabel(`${' '.repeat(PAYMENT_METHOD_LABEL_COST_CEILING - 2)}BCA`)).not.toBe('BCA');
  });
});

describe('the cost ceiling must sit strictly above the label length limit, or an over-ceiling input can be truncated straight into an ACCEPTED label', () => {
  it('PAYMENT_METHOD_LABEL_COST_CEILING is greater than PAYMENT_METHOD_LABEL_MAX_LEN', () => {
    expect(PAYMENT_METHOD_LABEL_COST_CEILING).toBeGreaterThan(PAYMENT_METHOD_LABEL_MAX_LEN);
  });
});

describe('normalizePaymentMethodLabel stays fast on pathological input, because the raw ceiling is checked BEFORE the edge-whitespace regex ever runs', () => {
  it.each<[string, string]>([
    [
      'a non-space character, 99,000 interior spaces, then a non-space character — well over the ceiling, so the trim never runs at all',
      `x${' '.repeat(99_000)}x`,
    ],
    [
      'a non-space character, (ceiling - 2) interior spaces, then a non-space character — AT the ceiling, so the trim runs for real',
      `x${' '.repeat(PAYMENT_METHOD_LABEL_COST_CEILING - 2)}x`,
    ],
  ])('normalizes %s in well under 50ms', (_label, raw) => {
    const start = performance.now();
    normalizePaymentMethodLabel(raw);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('NO_CONTROL_OR_FORMAT_CHARS_RE agrees with checkPaymentDestination on every bad_chars corpus code point', () => {
  const badCodePoints = [...DANGEROUS_CONTROL_OR_FORMAT_CODE_POINTS, ...WIDENED_BAD_CODE_POINTS];

  it.each(badCodePoints)('rejects %s exactly where checkPaymentDestination classifies it bad_chars', (_label, codePoint) => {
    const destination = `BCA 123${codePoint}456`;
    expect(checkPaymentDestination(destination)).toEqual({ ok: false, problem: 'bad_chars' });
    expect(NO_CONTROL_OR_FORMAT_CHARS_RE.test(codePoint)).toBe(false);
  });

  it('accepts a plain ASCII letter on both sides', () => {
    expect(checkPaymentDestination('BCA 123B456').ok).toBe(true);
    expect(NO_CONTROL_OR_FORMAT_CHARS_RE.test('B')).toBe(true);
  });

  it('accepts an emoji on both sides, since it is neither a control nor a format character', () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(checkPaymentDestination(`BCA 123${emoji}456`).ok).toBe(true);
    expect(NO_CONTROL_OR_FORMAT_CHARS_RE.test(emoji)).toBe(true);
  });
});
