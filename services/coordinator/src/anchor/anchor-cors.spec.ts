import 'reflect-metadata';
import { anchorCorsOptions, isAnchorPath } from './anchor-cors';
import { Sep10Controller } from '../sep10/sep10.controller';

describe('the anchor surface is known by path, not by guesswork', () => {
  it.each(['/auth', '/auth/', '/AUTH', '/Auth/', '/AuTh'])('treats %s as anchor surface', (p) => {
    expect(isAnchorPath(p)).toBe(true);
  });

  it.each(['/authenticate', '/auth/challenge', '/auth/verify', '/orders', '/profile', '/'])(
    'leaves %s to the ordinary policy',
    (p) => {
      expect(isAnchorPath(p)).toBe(false);
    },
  );
});

describe('the list covers the path the controller is actually mounted at', () => {
  it('matches the SEP-10 controller prefix, so renaming it cannot break CORS silently', () => {
    const prefix = Reflect.getMetadata('path', Sep10Controller);

    expect(prefix).toBeTruthy();
    expect(isAnchorPath(`/${prefix}`)).toBe(true);
  });
});

describe('anchor endpoints answer every origin, and never with credentials', () => {
  const allowlist = ['https://app.lolipay.app'];

  it('answers a wildcard for an unknown origin on the anchor surface', () => {
    const opts = anchorCorsOptions('/auth', allowlist);

    expect(opts.origin).toBe('*');
    expect(opts.credentials).toBe(false);
  });

  it('allows the preflight method SEP-10 needs', () => {
    const opts = anchorCorsOptions('/auth', allowlist);

    expect(opts.methods).toContain('OPTIONS');
    expect(opts.methods).toContain('POST');
    expect(opts.methods).toContain('GET');
  });

  it('keeps the credentialed allowlist for everything else', () => {
    const opts = anchorCorsOptions('/orders', allowlist);

    expect(opts.origin).toEqual(allowlist);
    expect(opts.credentials).toBe(true);
  });

  it('refuses every origin on the ordinary surface when no allowlist is configured', () => {
    const opts = anchorCorsOptions('/orders', []);

    expect(opts.origin).toBe(false);
  });

  it('still answers the anchor surface when no allowlist is configured', () => {
    const opts = anchorCorsOptions('/auth', []);

    expect(opts.origin).toBe('*');
  });
});

describe('a wallet that never heard of lolipay can reach the SEP-24 surface', () => {
  const SEP24 = [
    '/sep24/info',
    '/sep24/transaction',
    '/sep24/transactions',
    '/sep24/transactions/deposit/interactive',
    '/sep24/more-info/abc',
  ];

  it.each(SEP24)('treats %s as anchor surface, not as an allowlisted origin', (path) => {
    const opts = anchorCorsOptions(path, ['https://app.lolipay.app']);
    expect(opts.origin).toBe('*');
    expect(opts.credentials).toBe(false);
  });

  it.each(SEP24)('lets %s carry the bearer token four of these endpoints require', (path) => {
    expect(anchorCorsOptions(path, []).allowedHeaders).toContain('Authorization');
  });

  it('still answers a wildcard for the SEP-10 endpoint it already served', () => {
    expect(anchorCorsOptions('/auth', []).origin).toBe('*');
  });

  it('does not turn an ordinary route into anchor surface by having sep24 in its name', () => {
    expect(anchorCorsOptions('/orders/sep24', ['https://app.lolipay.app']).origin).toEqual([
      'https://app.lolipay.app',
    ]);
  });
});

describe('the KYC server the toml advertises is reachable from a browser wallet', () => {
  it.each(['/customer', '/customer/GABCDEF', '/customer/callback'])(
    'treats %s as anchor surface, because a wallet drives SEP-12 itself',
    (path) => {
      const opts = anchorCorsOptions(path, ['https://app.lolipay.app']);
      expect(opts.origin).toBe('*');
      expect(opts.credentials).toBe(false);
      expect(opts.allowedHeaders).toContain('Authorization');
    },
  );

  it('does not turn an ordinary route into anchor surface by starting with the same letters', () => {
    expect(anchorCorsOptions('/customers-admin', ['https://app.lolipay.app']).origin).toEqual([
      'https://app.lolipay.app',
    ]);
  });

  it('allows the verbs SEP-12 needs, not only the ones SEP-10 does', () => {
    expect(anchorCorsOptions('/customer', []).methods).toEqual(
      expect.arrayContaining(['GET', 'PUT', 'DELETE', 'OPTIONS']),
    );
  });
});
