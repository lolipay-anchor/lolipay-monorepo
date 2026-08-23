import 'reflect-metadata';
import { anchorCorsOptions, isAnchorPath } from './anchor-cors';
import { Sep10Controller } from '../sep10/sep10.controller';

describe('the anchor surface is known by path, not by guesswork', () => {
  it.each(['/auth', '/auth/'])('treats %s as anchor surface', (p) => {
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
