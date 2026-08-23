export interface AdvertisedAnchor {
  SIGNING_KEY?: string;
  WEB_AUTH_ENDPOINT?: string;
  NETWORK_PASSPHRASE?: string;
}

export interface ServedChallenge {
  source: string;
  webAuthDomain: string;
  networkPassphrase: string;
}

export function compareAnchorIdentity(
  toml: AdvertisedAnchor,
  challenge: ServedChallenge,
): string[] {
  const problems: string[] = [];

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
