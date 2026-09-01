import { renderSignScript } from './sign-script';

const RPC = 'https://rpc.example.test';

describe('the script that asks a wallet to sign, and what it is allowed to claim', () => {
  const fund = renderSignScript('tx-1', 'fund', RPC);
  const release = renderSignScript('tx-1', 'release', RPC);

  it('asks its own builder and never the other half of the trade', () => {
    expect(fund).toContain("'/fund-tx'");
    expect(fund).not.toContain("'/release-tx'");
    expect(release).toContain("'/release-tx'");
    expect(release).not.toContain("'/fund-tx'");
  });

  it('only claims the escrow moved once the network says SUCCESS', () => {
    for (const script of [fund, release]) {
      expect(script).toContain("if (status === 'SUCCESS') return true;");
      expect(script).toContain("method: method");
      expect(script).toContain("'getTransaction'");
    }
  });

  it('does not tell the user it failed when the network has merely not answered', () => {
    for (const script of [fund, release]) {
      const unresolved = script.slice(script.indexOf('function again()'), script.indexOf('go.addEventListener'));
      expect(unresolved).toContain('if (Date.now() > deadline) return null;');
      expect(unresolved).not.toContain('throw');
    }
  });

  it('reloads whether or not the network confirmed, so the page states the truth', () => {
    for (const script of [fund, release]) {
      expect(script).toContain('window.location.reload();');
      expect(script).toContain('The network has not said yet whether it applied');
    }
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
