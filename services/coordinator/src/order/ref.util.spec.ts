import { generateRef, REF_ALPHABET } from './ref.util';

describe('generateRef', () => {
  it('matches the LP-XXXX format (4 chars from the alphabet)', () => {
    const ref = generateRef();
    expect(ref).toMatch(new RegExp(`^LP-[${REF_ALPHABET}]{4}$`));
  });

  it('never contains ambiguous characters (0, O, 1, I, L) in the generated suffix', () => {
    for (let i = 0; i < 200; i++) {
      const suffix = generateRef().slice(3);
      expect(suffix).not.toMatch(/[01OIL]/);
    }
  });

  it('every generated character is drawn from REF_ALPHABET (1000 generations)', () => {
    const allowed = new Set(REF_ALPHABET.split(''));
    for (let i = 0; i < 1000; i++) {
      const ref = generateRef();
      const suffix = ref.slice(3);
      expect(suffix).toHaveLength(4);
      for (const ch of suffix) {
        expect(allowed.has(ch)).toBe(true);
      }
    }
  });

  it('distribution sanity: over many generations, most alphabet characters appear at least once', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const ref = generateRef();
      for (const ch of ref.slice(3)) seen.add(ch);
    }

    expect(seen.size).toBeGreaterThan(REF_ALPHABET.length * 0.9);
  });

  it('generates distinct refs across repeated calls (no obvious collision pattern in a small sample)', () => {
    const refs = new Set<string>();
    for (let i = 0; i < 200; i++) refs.add(generateRef());

    expect(refs.size).toBeGreaterThan(150);
  });
});
