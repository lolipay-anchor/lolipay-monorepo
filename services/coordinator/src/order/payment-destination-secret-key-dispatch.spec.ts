import { explainOrderRefusal } from '../../../../frontend/apps/web/lib/order-refusal';
import {
  interactiveSentenceOf,
  PAYMENT_DESTINATION_BAD_CHARS_SENTENCE,
  PAYMENT_DESTINATION_MISSING_SENTENCE,
  PAYMENT_DESTINATION_TOO_LONG_SENTENCE,
  PAYMENT_DESTINATION_TOO_SHORT_SENTENCE,
} from '../sep24/interactive-sentence';
import { validatePaymentDestination } from './order.service';
import {
  checkPaymentDestination,
  PAYMENT_DESTINATION_MAX_LEN,
  PAYMENT_DESTINATION_SECRET_KEY_SENTENCE,
  type PaymentDestinationProblem,
} from './payment-destination';

const seedShape = (body = 'A') => `S${body.repeat(Math.ceil(55 / body.length)).slice(0, 55)}`;

const REACHES_EVERY_PROBLEM: Array<[PaymentDestinationProblem, unknown, string]> = [
  ['missing', undefined, PAYMENT_DESTINATION_MISSING_SENTENCE],
  ['too_long', 'B'.repeat(PAYMENT_DESTINATION_MAX_LEN + 1), PAYMENT_DESTINATION_TOO_LONG_SENTENCE],
  ['bad_chars', `BCA 123${String.fromCodePoint(0x202e)}456`, PAYMENT_DESTINATION_BAD_CHARS_SENTENCE],
  ['secret_key', seedShape(), PAYMENT_DESTINATION_SECRET_KEY_SENTENCE],
  ['too_short', 'BNI 99', PAYMENT_DESTINATION_TOO_SHORT_SENTENCE],
];

describe('every problem code the predicate can return reaches the depositor as its OWN sentence, carried on the interactive channel', () => {
  it.each(REACHES_EVERY_PROBLEM)(
    'a destination the predicate classifies %s gets its own sentence, and it is the one attached for the SEP-24 popup',
    (problem, raw, sentence) => {
      const check = checkPaymentDestination(raw);
      expect(check).toEqual({ ok: false, problem });

      let thrown: unknown;
      try {
        validatePaymentDestination(raw);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error).message).toBe(sentence);
      expect(interactiveSentenceOf(thrown)).toBe(sentence);
    },
  );

  it('no two problem codes share a sentence, so none can be silently mapped onto another the way secret_key was mapped onto too_short', () => {
    const sentences = REACHES_EVERY_PROBLEM.map(([, , sentence]) => sentence);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('covers every member of the problem union, so a sixth code cannot be added without taking a row here', () => {
    const covered: Record<PaymentDestinationProblem, true> = {
      missing: true,
      too_long: true,
      bad_chars: true,
      secret_key: true,
      too_short: true,
    };
    expect(REACHES_EVERY_PROBLEM.map(([problem]) => problem).sort()).toEqual(
      Object.keys(covered).sort(),
    );
  });
});

describe('the secret-key problem code reaches the depositor surface as its OWN sentence, not as the too-short one', () => {
  it('the fixture is the 56-character shape a wallet export produces, and the predicate classifies it secret_key', () => {
    expect(seedShape()).toHaveLength(56);
    expect(checkPaymentDestination(seedShape())).toEqual({ ok: false, problem: 'secret_key' });
  });

  it.each<[string, string]>([
    ['the seed on its own', seedShape()],
    ['a word before it', `BCA ${seedShape()}`],
    ['no separator at all', `BCA123${seedShape()}`],
  ])('refuses a destination carrying %s with the secret-key sentence', (_label, raw) => {
    expect(() => validatePaymentDestination(raw)).toThrow(PAYMENT_DESTINATION_SECRET_KEY_SENTENCE);
  });

  it.each<[string, string]>([
    ['the seed on its own', seedShape()],
    ['a word before it', `BCA ${seedShape()}`],
    ['no separator at all', `BCA123${seedShape()}`],
  ])(
    'does NOT tell someone who pasted %s to enter more of it, which is what the unwired dispatch did',
    (_label, raw) => {
      expect(() => validatePaymentDestination(raw)).not.toThrow(
        PAYMENT_DESTINATION_TOO_SHORT_SENTENCE,
      );
    },
  );

  it('a destination that really is too short still gets the too-short sentence, so the branch above is not swallowing everything', () => {
    expect(() => validatePaymentDestination('BNI 99')).toThrow(PAYMENT_DESTINATION_TOO_SHORT_SENTENCE);
  });

  it('carries the sentence on the exception so the SEP-24 popup renders it, exactly as its four siblings do', () => {
    let thrown: unknown;
    try {
      validatePaymentDestination(seedShape());
    } catch (err) {
      thrown = err;
    }
    expect(interactiveSentenceOf(thrown)).toBe(PAYMENT_DESTINATION_SECRET_KEY_SENTENCE);
  });
});

describe('a lowercased paste is still leaked key material, so the shape is matched without regard to case', () => {
  it.each<[string, string]>([
    ['entirely lowercase, as a terminal copy can produce', `s${'a'.repeat(55)}`],
    ['mixed case', `S${'a'.repeat(27)}${'A'.repeat(28)}`],
  ])('refuses a destination carrying a seed shape %s', (_label, raw) => {
    expect(checkPaymentDestination(raw)).toEqual({ ok: false, problem: 'secret_key' });
    expect(() => validatePaymentDestination(raw)).toThrow(PAYMENT_DESTINATION_SECRET_KEY_SENTENCE);
  });

  it.each<[string, string]>([
    ['a real bank destination whose letters are lowercase', 'bca 1234567890 sigit prayogo'],
    ['a lowercase run one character short of the seed length', `s${'a'.repeat(54)}`],
    ['the seed length in lowercase but carrying a digit outside the base32 alphabet', `s${'a'.repeat(54)}0`],
  ])('still accepts %s', (_label, raw) => {
    expect(checkPaymentDestination(raw)).toEqual({ ok: true, value: raw });
  });
});

describe("the web app passes the secret-key sentence through to the depositor verbatim, rather than swapping it for one of its own", () => {
  it('explainOrderRefusal returns the sentence unchanged', () => {
    expect(explainOrderRefusal(PAYMENT_DESTINATION_SECRET_KEY_SENTENCE)).toBe(
      PAYMENT_DESTINATION_SECRET_KEY_SENTENCE,
    );
  });

  it.each<[string, string]>([
    ['a message naming an expired quote', 'quote expired'],
    ['a message naming the current limits', 'amount outside current limits'],
    ['a transport failure', 'failed to fetch'],
  ])('replaces %s, so the assertion above is not passing because the filter is inert', (_label, message) => {
    expect(explainOrderRefusal(message)).not.toBe(message);
  });
});
