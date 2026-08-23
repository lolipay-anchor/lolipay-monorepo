import { StellarToml, Transaction } from '@stellar/stellar-sdk';
import { compareAnchorIdentity } from '../anchor/consistency';

const domain = process.argv[2];

async function main(): Promise<void> {
  if (!domain) {
    console.error('usage: anchor-consistency <home-domain>');
    process.exit(2);
  }

  const toml = (await StellarToml.Resolver.resolve(domain, { timeout: 15000, allowedRedirects: 3 })) as Record<string, string>;
  if (!toml.WEB_AUTH_ENDPOINT) {
    console.error('the toml advertises no WEB_AUTH_ENDPOINT — nothing to cross-check');
    process.exit(1);
  }

  const probe = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const body = await fetchText(`${toml.WEB_AUTH_ENDPOINT}?account=${probe}`);
  const answer = JSON.parse(body) as { transaction: string; network_passphrase: string };
  const tx = new Transaction(answer.transaction, answer.network_passphrase);
  const webAuthOp = tx.operations.find(
    (op) => (op as { name?: string }).name === 'web_auth_domain',
  ) as { value: Uint8Array } | undefined;
  const homeDomainKey = (tx.operations[0] as { name?: string }).name ?? '';

  const problems = compareAnchorIdentity(
    toml,
    {
      source: tx.source,
      webAuthDomain: webAuthOp ? Buffer.from(webAuthOp.value).toString() : '',
      homeDomain: homeDomainKey.replace(/ auth$/, ''),
      networkPassphrase: answer.network_passphrase,
    },
    domain,
  );

  if (problems.length === 0) {
    console.log(`${domain}: the toml and the live challenge agree`);
    return;
  }
  problems.forEach((p) => console.error(`${domain}: ${p}`));
  process.exitCode = 1;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}


main().catch((err) => {
  console.error(`${domain}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
