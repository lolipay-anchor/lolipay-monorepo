import helmet from 'helmet';
import { cspAllowingRpc } from './signing-csp';

const RPC = 'https://soroban-testnet.stellar.org';

describe('the signing page opens exactly one directive and inherits the rest', () => {
  it('keeps every directive helmet ships, so this cannot drift when helmet changes', () => {
    const csp = cspAllowingRpc(RPC);
    for (const name of Object.keys(helmet.contentSecurityPolicy.getDefaultDirectives())) {
      expect([name, csp.includes(name)]).toEqual([name, true]);
    }
  });

  it('still refuses inline script, which is what makes the external file necessary', () => {
    const csp = cspAllowingRpc(RPC);
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src ')) as string;
    expect(scriptSrc.trim()).toBe("script-src 'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(csp).toContain("script-src-attr 'none'");
  });

  it('adds the RPC origin to connect-src and nothing else to it', () => {
    expect(cspAllowingRpc(RPC)).toContain("connect-src 'self' https://soroban-testnet.stellar.org");
  });

  it('carries only the origin, never a path an operator happened to configure', () => {
    const csp = cspAllowingRpc('https://rpc.example.com/some/path?k=v');
    const connect = csp.split(';').find((d) => d.trim().startsWith('connect-src')) as string;
    expect(connect.trim()).toBe("connect-src 'self' https://rpc.example.com");
    expect(csp).not.toContain('/some/path');
  });

  it('falls back to self alone when the configured URL is not a URL, rather than emitting rubbish', () => {
    const csp = cspAllowingRpc('not a url');
    const connect = csp.split(';').find((d) => d.trim().startsWith('connect-src')) as string;
    expect(connect.trim()).toBe("connect-src 'self'");
    expect(csp).not.toContain('not a url');
  });

  it('does not widen default-src, so everything but the RPC stays same-origin', () => {
    expect(cspAllowingRpc(RPC)).toContain("default-src 'self'");
  });
});
