import {
  originIsForeign,
  readCookies,
  sessionCookieName,
  sessionCookieOptions,
} from './interactive-session';
import { SEP24_INTERACTIVE_TTL_SECS } from './interactive-token';

const BASE = 'https://api.lolipay.app';

describe('the cookie that keeps the write credential out of every log', () => {
  it('is scoped to one transaction, so a second deposit in the same browser cannot collide', () => {
    const a = sessionCookieName('7a1f0c9e-0000-4000-8000-000000000001');
    const b = sessionCookieName('7a1f0c9e-0000-4000-8000-000000000002');
    expect(a).not.toBe(b);
    expect(sessionCookieOptions('abc').path).toBe('/sep24/interactive/abc');
  });

  it('cannot be read by script, cannot travel in the clear, and cannot ride a cross-site post', () => {
    const o = sessionCookieOptions('abc');
    expect(o.httpOnly).toBe(true);
    expect(o.secure).toBe(true);
    expect(o.sameSite).toBe('lax');
  });

  it('lives exactly as long as the token life the anchor advertises', () => {
    expect(sessionCookieOptions('abc').maxAge).toBe(SEP24_INTERACTIVE_TTL_SECS * 1000);
  });

  it('refuses a name that could smuggle characters into the header', () => {
    expect(sessionCookieName('a b;c=d\nz')).toBe('sep24_abcdz');
  });
});

describe('reading one cookie out of a header nobody sanitised', () => {
  it('finds the value it was asked for', () => {
    expect(readCookies('other=1; sep24_abc=xyz; more=2', 'sep24_abc')).toEqual(['xyz']);
  });

  it('does not match a name that merely ends the same way', () => {
    expect(readCookies('nope_sep24_abc=xyz', 'sep24_abc')).toEqual([]);
  });

  it('answers nothing rather than guessing when there is no header', () => {
    expect(readCookies(undefined, 'sep24_abc')).toEqual([]);
    expect(readCookies('', 'sep24_abc')).toEqual([]);
    expect(readCookies('malformed', 'sep24_abc')).toEqual([]);
  });
});

describe('an origin the anchor did not serve cannot post into the flow', () => {
  it('accepts a request from the anchor itself', () => {
    expect(originIsForeign('https://api.lolipay.app', BASE)).toBe(false);
  });

  it('accepts a request that carries no origin at all, which is what a wallet backend does', () => {
    expect(originIsForeign(undefined, BASE)).toBe(false);
  });

  it.each([
    'https://evil.example',
    'http://api.lolipay.app',
    'https://api.lolipay.app.evil.example',
    'null',
    'not a url',
  ])('refuses %s', (origin) => {
    expect(originIsForeign(origin, BASE)).toBe(true);
  });
});

describe('a cookie another host planted cannot hide the real one', () => {
  it('returns every value under the name, in the order the browser sent them', () => {
    expect(readCookies('sep24_abc=planted; sep24_abc=real', 'sep24_abc')).toEqual([
      'planted',
      'real',
    ]);
  });

  it('keeps scanning past a value that cannot be decoded', () => {
    expect(readCookies('sep24_abc=%; sep24_abc=real', 'sep24_abc')).toEqual(['real']);
  });
});
