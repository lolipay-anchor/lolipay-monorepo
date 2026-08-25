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

const STAKING_ERRORS: Record<number, string> = {
  2: 'the staking contract is not initialised',
  3: 'the staking contract is paused on-chain',
  4: 'the amount is not accepted by the staking contract — it must be positive and within what is still recoverable on this trade',
  5: 'the provider does not have that much staked',
  6: 'the provider no longer holds enough collateral to cover this amount — its bond may already have been withdrawn',
  9: 'the caller is not the resolver or the administrator of the staking contract',
  12: 'no post-settlement dispute was raised on this trade, so there is nothing to enforce',
  13: 'that address is not a party to this trade',
  14: 'this trade has already been slashed for its full value',
  17: 'a slash does not apply here — the trade has not settled, or that address is not the party that ended up holding the money',
  18: 'the window to slash this trade has closed',
  19: 'the staking contract could not read the escrow — it refuses to act rather than act on no evidence',
  20: 'a verdict is still pending on this trade — resolve the dispute first, then slash',
  21: 'no liability has been established on this trade — resolving it in the counterparty\'s favour is what establishes liability',
};

export function describeStakingError(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(CONTRACT_ERROR_RE);
  if (!m) return null;
  const code = Number(m[1]);
  return STAKING_ERRORS[code] ?? `the staking contract rejected this call (error #${code})`;
}

export function describeContractError(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(CONTRACT_ERROR_RE);
  if (!m) return null;
  const code = Number(m[1]);
  return ESCROW_ERRORS[code] ?? `the escrow contract rejected this call (error #${code})`;
}
