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
    expect(sanitizeForLog('a\u0085b c d')).toBe('a b c d');
  });

  it('caps length at 200 by default', () => {
    expect(sanitizeForLog('x'.repeat(500)).length).toBe(200);
  });

  it('caps length at a given maximum', () => {
    expect(sanitizeForLog('x'.repeat(500), 120).length).toBe(120);
  });
});
