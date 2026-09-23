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
  PAYMENT_METHOD_LABEL_HAS_LETTERS_RE,
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

  it.each([4_000, 16_000, 50_000, 99_000])(
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
