const NETWORKS: Record<string, string> = {
  'Test SDF Network ; September 2015': 'testnet',
  'Public Global Stellar Network ; September 2015': 'public',
};

export function explorerTxUrl(networkPassphrase: string, hash: string): string | null {
  const network = Object.hasOwn(NETWORKS, networkPassphrase) ? NETWORKS[networkPassphrase] : undefined;
  return network ? `https://stellar.expert/explorer/${network}/tx/${encodeURIComponent(hash)}` : null;
}
