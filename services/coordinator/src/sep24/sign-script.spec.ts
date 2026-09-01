import { renderSignScript } from './sign-script';

const RPC = 'https://rpc.example.test';

describe('what the served signing script is, before anything runs it', () => {
  const fund = renderSignScript('tx-1', 'fund', RPC);
  const release = renderSignScript('tx-1', 'release', RPC);

  it('asks its own builder and never the other half of the trade', () => {
    expect(fund).toContain("'/fund-tx'");
    expect(fund).not.toContain("'/release-tx'");
    expect(release).toContain("'/release-tx'");
    expect(release).not.toContain("'/fund-tx'");
  });

  it('writes every message as text, never as markup', () => {
    for (const script of [fund, release]) {
      expect(script).toContain('out.textContent = t;');
      expect(script).not.toContain('innerHTML');
    }
  });

  it('carries the RPC url it was given and no other origin', () => {
    expect(fund).toContain(JSON.stringify(RPC));
    expect(renderSignScript('tx-1', 'fund', 'https://other.test')).not.toContain(RPC);
  });
});
