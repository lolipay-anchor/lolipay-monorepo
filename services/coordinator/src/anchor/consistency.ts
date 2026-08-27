import { StellarToml, Transaction } from '@stellar/stellar-sdk';

export interface AdvertisedAnchor {
  SIGNING_KEY?: string;
  WEB_AUTH_ENDPOINT?: string;
  NETWORK_PASSPHRASE?: string;
}

export interface ServedChallenge {
  source: string;
  webAuthDomain: string;
  homeDomain: string;
  networkPassphrase: string;
}

export function compareAnchorIdentity(
  toml: AdvertisedAnchor,
  challenge: ServedChallenge,
  homeDomain: string,
): string[] {
  const problems: string[] = [];

  if (challenge.homeDomain.toLowerCase() !== homeDomain.toLowerCase()) {
    problems.push(
      `the challenge names the home domain ${challenge.homeDomain} but the toml was fetched ` +
        `from ${homeDomain}, so every wallet will reject it`,
    );
  }

  if (!toml.SIGNING_KEY) {
    problems.push('the toml advertises no SIGNING_KEY');
  } else if (toml.SIGNING_KEY !== challenge.source) {
    problems.push(
      `the toml advertises SIGNING_KEY ${toml.SIGNING_KEY} but the challenge is sourced by ` +
        `${challenge.source}`,
    );
  }

  const advertisedHost = hostOf(toml.WEB_AUTH_ENDPOINT);
  if (advertisedHost === null) {
    problems.push('the toml advertises no usable WEB_AUTH_ENDPOINT');
  } else if (advertisedHost !== challenge.webAuthDomain) {
    problems.push(
      `the challenge names web_auth_domain ${challenge.webAuthDomain} but the toml advertises ` +
        `a WEB_AUTH_ENDPOINT on ${advertisedHost}`,
    );
  }

  if (!toml.NETWORK_PASSPHRASE) {
    problems.push('the toml advertises no NETWORK_PASSPHRASE');
  } else if (toml.NETWORK_PASSPHRASE !== challenge.networkPassphrase) {
    problems.push('the toml and the challenge name different Stellar networks');
  }

  return problems;
}

function hostOf(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

export interface AnchorProbe {
  resolveToml?: (domain: string) => Promise<Record<string, string>>;
  fetchImpl?: (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;
  readChallenge?: (transaction: string, networkPassphrase: string) => ServedChallenge;
  timeoutMs?: number;
}

export async function checkAnchorIdentity(
  domain: string,
  probe: AnchorProbe = {},
): Promise<string[]> {
  const timeout = probe.timeoutMs ?? 15000;
  const fetchImpl = probe.fetchImpl ?? defaultFetch(timeout);
  const resolveToml = probe.resolveToml ?? defaultResolve(timeout);
  const toml = await resolveToml(domain);

  if (!toml.WEB_AUTH_ENDPOINT) {
    throw new Error('the toml advertises no WEB_AUTH_ENDPOINT, so there is nothing to cross-check');
  }

  const probeAccount = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const res = await fetchImpl(`${toml.WEB_AUTH_ENDPOINT}?account=${probeAccount}`);
  if (!res.ok) throw new Error(`${toml.WEB_AUTH_ENDPOINT} answered ${(res as { status?: number }).status ?? 'badly'}`);
  const answer = JSON.parse(await res.text()) as { transaction: string; network_passphrase: string };

  const read = probe.readChallenge ?? readServedChallenge;
  return compareAnchorIdentity(toml, read(answer.transaction, answer.network_passphrase), domain);
}

export function readServedChallenge(transaction: string, networkPassphrase: string): ServedChallenge {
  const tx = new Transaction(transaction, networkPassphrase);
  const webAuthOp = tx.operations.find(
    (op) => (op as { name?: string }).name === 'web_auth_domain',
  ) as { value: Uint8Array } | undefined;
  const homeDomainKey = (tx.operations[0] as { name?: string }).name ?? '';
  return {
    source: tx.source,
    webAuthDomain: webAuthOp ? Buffer.from(webAuthOp.value).toString() : '',
    homeDomain: homeDomainKey.replace(/ auth$/, ''),
    networkPassphrase,
  };
}

function defaultResolve(timeoutMs: number) {
  return async (domain: string): Promise<Record<string, string>> =>
    (await StellarToml.Resolver.resolve(domain, {
      timeout: timeoutMs,
      allowedRedirects: 3,
    })) as Record<string, string>;
}

function defaultFetch(timeoutMs: number) {
  return (url: string) => fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}
