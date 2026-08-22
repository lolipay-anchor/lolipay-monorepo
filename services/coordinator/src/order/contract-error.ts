const CONTRACT_ERROR_RE = /Error\(Contract,\s*#(\d+)\)/i;

const ESCROW_ERRORS: Record<number, string> = {
  3: 'the escrow contract is paused on-chain',
  4: 'a trade already exists for this id on-chain',
  5: 'no trade exists for this id on-chain',
  6: 'the amount is not accepted by the escrow contract',
  7: 'the fee configuration does not match the escrow contract — check platformFeeBps and platformWallet against the deployed config',
  8: 'the deadlines do not satisfy the escrow contract bounds — check payWindowSecs, confirmWindowSecs and disputeWindowSecs',
  9: 'the trade is not in a state that allows this call',
  10: 'the deadline for this call has already passed',
  11: 'the deadline for this call has not been reached yet',
  12: 'the caller is not authorised for this call',
  13: 'the trade is not disputed',
  16: 'the roles do not satisfy the escrow contract',
};

export function describeContractError(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(CONTRACT_ERROR_RE);
  if (!m) return null;
  const code = Number(m[1]);
  return ESCROW_ERRORS[code] ?? `the escrow contract rejected this call (error #${code})`;
}
