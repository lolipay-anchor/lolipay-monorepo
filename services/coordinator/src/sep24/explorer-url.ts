export function explorerTxUrl(networkPassphrase: string, hash: string): string {
  const network = networkPassphrase.includes('Test SDF Network') ? 'testnet' : 'public';
  return `https://stellar.expert/explorer/${network}/tx/${encodeURIComponent(hash)}`;
}
