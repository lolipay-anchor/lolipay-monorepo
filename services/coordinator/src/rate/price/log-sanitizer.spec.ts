import { sanitizeForLog } from './log-sanitizer';

describe('sanitizeForLog', () => {
  it('leaves a clean, short string unchanged', () => {
    expect(sanitizeForLog('coingecko 429')).toBe('coingecko 429');
  });

  it('replaces CR and LF with a space', () => {
    expect(sanitizeForLog('a\r\nb')).toBe('a b');
  });

  it('replaces ESC, NUL, BEL and TAB with a space', () => {
    expect(sanitizeForLog('a\x1bb\x00c\x07d\te')).not.toMatch(/[\x00-\x1f]/);
  });

  it('replaces DEL (0x7f) with a space', () => {
    expect(sanitizeForLog('a\x7fb')).toBe('a b');
  });

  it('replaces NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR with a space', () => {
    const input = 'a' + String.fromCodePoint(0x85) + 'b' + String.fromCodePoint(0x2028) + 'c' + String.fromCodePoint(0x2029) + 'd';
    expect(sanitizeForLog(input)).toBe('a b c d');
  });

  it('replaces the single-character CSI (0x9b), the C1 twin of ESC[, with a space', () => {
    const input = 'a' + String.fromCodePoint(0x9b) + 'b';
    expect(sanitizeForLog(input)).toBe('a b');
  });

  it('replaces bidi overrides and other Unicode format/whitespace characters outside printable ASCII', () => {
    const input =
      'a' +
      String.fromCodePoint(0x202e) +
      'b' +
      String.fromCodePoint(0x200b) +
      'c' +
      String.fromCodePoint(0xa0) +
      'd' +
      String.fromCodePoint(0xfeff) +
      'e';
    expect(sanitizeForLog(input)).toBe('a b c d e');
  });

  it('replaces the whole class outside printable ASCII, as a mechanism rather than an enumerated list', () => {
    for (const codePoint of [0x84, 0x8d, 0x9c, 0x9d, 0x202d, 0x2066, 0x2069, 0x200e, 0x200f, 0x180e]) {
      const ch = String.fromCodePoint(codePoint);
      expect(sanitizeForLog('a' + ch + 'b')).toBe('a b');
    }
  });

  it('never leaves a lone surrogate half after capping length', () => {
    const input = 'B'.repeat(199) + String.fromCodePoint(0x1f600) + 'tail';
    const out = sanitizeForLog(input);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toMatch(/[\ud800-\udbff]$/);
  });

  it('caps length at 200 by default', () => {
    expect(sanitizeForLog('x'.repeat(500)).length).toBe(200);
  });

  it('caps length at a given maximum', () => {
    expect(sanitizeForLog('x'.repeat(500), 120).length).toBe(120);
  });

  it('replace runs a run before slicing, so a long unsafe run collapses to one space rather than filling the cap', () => {
    expect(sanitizeForLog('\x1b'.repeat(5000)).length).toBe(1);
  });
});
