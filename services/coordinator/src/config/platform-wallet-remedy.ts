export function platformWalletRemedy(chainWallet: string): string {
  return chainWallet.startsWith('G')
    ? 'until the row is patched to match'
    : 'and the row cannot be patched to match, because the admin API accepts only G addresses, so this deployment needs a contract whose platform wallet is a G address';
}
