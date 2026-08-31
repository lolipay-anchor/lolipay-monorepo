import {
  mintInteractiveToken,
  readInteractiveToken,
  SEP24_INTERACTIVE_AUDIENCE,
  SEP24_INTERACTIVE_LINK_TTL_SECS,
  SEP24_INTERACTIVE_TTL_SECS,
} from './interactive-token';
import jwt from 'jsonwebtoken';

const SIGNING_KEY = ['unit', 'test', 'signing', 'key', '0123456789'].join('-');
const OTHER_KEY = ['some', 'other', 'signing', 'key', '9876543210'].join('-');
const cfg = {
  jwtSecret: SIGNING_KEY,
  jwtIssuer: 'https://lolipay.app',
  jwtAudience: 'lolipay-app',
} as any;
const TX = '7a1f0c9e-0000-4000-8000-000000000001';
const ACCT = 'GBKBPRR63VBOLS6MCWSC6ZRXVHBHYLEECZ627PH3LWJCRCI3LKWKJSWU';

describe('the token that makes an interactive URL authority, not just an identifier', () => {
  it('admits the transaction and account it was minted for', () => {
    const t = mintInteractiveToken(cfg, TX, ACCT);
    expect(readInteractiveToken(cfg, t, TX)).toEqual({ account: ACCT });
  });

  it('refuses a token minted for a different transaction, so one id cannot be replayed at another', () => {
    const t = mintInteractiveToken(cfg, TX, ACCT);
    expect(() => readInteractiveToken(cfg, t, 'another-transaction-id')).toThrow();
  });

  it('refuses a token signed with another key', () => {
    const forged = jwt.sign({ acct: ACCT }, OTHER_KEY, {
      subject: TX, issuer: cfg.jwtIssuer, audience: SEP24_INTERACTIVE_AUDIENCE, expiresIn: 60,
    });
    expect(() => readInteractiveToken(cfg, forged, TX)).toThrow();
  });

  it('refuses a token that differs from a good one only in its audience', () => {
    const wrongAudience = jwt.sign({ acct: ACCT }, cfg.jwtSecret, {
      algorithm: 'HS256', subject: TX, issuer: cfg.jwtIssuer,
      audience: cfg.jwtAudience, expiresIn: 60,
    });
    expect(() => readInteractiveToken(cfg, wrongAudience, TX)).toThrow();
  });

  it('refuses a token that differs from a good one only in its issuer', () => {
    const wrongIssuer = jwt.sign({ acct: ACCT }, cfg.jwtSecret, {
      algorithm: 'HS256', subject: TX, issuer: 'https://somebody-else.example',
      audience: SEP24_INTERACTIVE_AUDIENCE, expiresIn: 60,
    });
    expect(() => readInteractiveToken(cfg, wrongIssuer, TX)).toThrow();
  });

  it('refuses a token that differs from a good one only in its algorithm', () => {
    const wrongAlg = jwt.sign({ acct: ACCT }, cfg.jwtSecret, {
      algorithm: 'HS512', subject: TX, issuer: cfg.jwtIssuer,
      audience: SEP24_INTERACTIVE_AUDIENCE, expiresIn: 60,
    });
    expect(() => readInteractiveToken(cfg, wrongAlg, TX)).toThrow();
  });

  it('refuses an expired token', () => {
    const stale = jwt.sign({ acct: ACCT }, cfg.jwtSecret, {
      subject: TX, issuer: cfg.jwtIssuer, audience: SEP24_INTERACTIVE_AUDIENCE, expiresIn: -1,
    });
    expect(() => readInteractiveToken(cfg, stale, TX)).toThrow();
  });

  it('refuses a token that names no account', () => {
    const empty = jwt.sign({}, cfg.jwtSecret, {
      subject: TX, issuer: cfg.jwtIssuer, audience: SEP24_INTERACTIVE_AUDIENCE, expiresIn: 60,
    });
    expect(() => readInteractiveToken(cfg, empty, TX)).toThrow();
  });

  it('refuses a token whose algorithm was swapped for none', () => {
    const unsigned = jwt.sign({ acct: ACCT }, '', {
      algorithm: 'none' as any, subject: TX, issuer: cfg.jwtIssuer,
      audience: SEP24_INTERACTIVE_AUDIENCE, expiresIn: 60,
    });
    expect(() => readInteractiveToken(cfg, unsigned, TX)).toThrow();
  });

  it('is not accepted by the ordinary API audience, which is the trap this exists to avoid', () => {
    const t = mintInteractiveToken(cfg, TX, ACCT);
    expect(() =>
      jwt.verify(t, cfg.jwtSecret, { audience: cfg.jwtAudience, issuer: cfg.jwtIssuer }),
    ).toThrow();
  });

  it('refuses a token that is not a token at all', () => {
    for (const junk of ['', 'not.a.token', 'a.b.c']) {
      expect(() => readInteractiveToken(cfg, junk, TX)).toThrow();
    }
  });
});

describe('the thirty minutes ADR 0030 promises is enforced by something', () => {
  it('mints a token that expires, and expires when the ADR says', () => {
    const decoded = jwt.decode(mintInteractiveToken(cfg, TX, ACCT)) as any;
    expect(decoded.exp).toBeDefined();
    expect(decoded.iat).toBeDefined();
    expect(decoded.exp - decoded.iat).toBe(SEP24_INTERACTIVE_TTL_SECS);
  });

  it('keeps that window at thirty minutes, because a URL in a browser history is the bearer', () => {
    expect(SEP24_INTERACTIVE_TTL_SECS).toBe(1800);
    expect(SEP24_INTERACTIVE_LINK_TTL_SECS).toBe(300);
  });
});
