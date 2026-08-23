import { jwtSignOptions, jwtVerifyOptions } from './jwt-options';
import { AppConfigService } from '../config/app-config.service';

function cfgWith(env: Record<string, string | undefined>): AppConfigService {
  return new AppConfigService({ get: (k: string) => env[k] } as any);
}

describe('the issuer claim is a URI, because the acceptance suite demands one', () => {
  it('defaults to an absolute https URI', () => {
    const issuer = jwtVerifyOptions(cfgWith({ JWT_SECRET: 'a'.repeat(32) })).issuer;

    const parsed = new URL(issuer);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.host).not.toBe('');
  });

  it('signs with the same URI it verifies against', () => {
    const cfg = cfgWith({ JWT_SECRET: 'a'.repeat(32) });

    expect(jwtSignOptions(cfg).issuer).toBe(jwtVerifyOptions(cfg).issuer);
  });

  it('takes the issuer from the environment when one is set', () => {
    const cfg = cfgWith({ JWT_SECRET: 'a'.repeat(32), JWT_ISSUER: 'https://anchor.example.org' });

    expect(jwtVerifyOptions(cfg).issuer).toBe('https://anchor.example.org/');
  });

  it('refuses an issuer that is not a URI, rather than serving tokens the suite rejects', () => {
    const cfg = cfgWith({ JWT_SECRET: 'a'.repeat(32), JWT_ISSUER: 'lolipay-coordinator' });

    expect(() => jwtVerifyOptions(cfg)).toThrow(/URI/i);
  });
});

describe('the issuer is normalised, and cannot smuggle a credential', () => {
  it('returns the normalised form, not the raw string', () => {
    const cfg = cfgWith({ JWT_SECRET: 'a'.repeat(32), JWT_ISSUER: 'HTTPS://LOLIPAY.APP' });

    expect(jwtVerifyOptions(cfg).issuer).toBe('https://lolipay.app/');
  });

  it('refuses an issuer with trailing whitespace, which passes URL but fails the suite', () => {
    const cfg = cfgWith({ JWT_SECRET: 'a'.repeat(32), JWT_ISSUER: 'https://lolipay.app ' });

    expect(jwtVerifyOptions(cfg).issuer).toBe('https://lolipay.app/');
  });

  it('refuses an issuer carrying a username or password', () => {
    const cfg = cfgWith({
      JWT_SECRET: 'a'.repeat(32),
      JWT_ISSUER: 'https://user:pass@lolipay.app',
    });

    expect(() => jwtVerifyOptions(cfg)).toThrow(/credential/i);
  });
});

