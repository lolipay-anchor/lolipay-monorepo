export const MIN_PAY_WINDOW_SECS = 600;
export const MIN_USABLE_PAY_WINDOW_SECS = MIN_PAY_WINDOW_SECS * 2;
export const signingDeadlineSecs = (payDeadline: number): number => payDeadline - MIN_PAY_WINDOW_SECS;
export const SIGNING_SUBMIT_MARGIN_SECS = 60;
export const signingCutoffSecs = (payDeadline: number): number => signingDeadlineSecs(payDeadline) - SIGNING_SUBMIT_MARGIN_SECS;
export const MAX_PAY_WINDOW_SECS = 86_400;
export const MAX_TOTAL_WINDOW_SECS = 2_592_000;

export const MAX_DISPUTE_WINDOW_SECS = 86_400;
export const RESOLVER_WINDOW_SECS = 86_400;
export const POST_VERDICT_GRACE_SECS = RESOLVER_WINDOW_SECS;

export const SLASH_CEILING_PAST_POST_SETTLE_SECS =
  2 * RESOLVER_WINDOW_SECS + POST_VERDICT_GRACE_SECS;

export const LONGEST_TAIL_PAST_SETTLEMENT_SECS =
  MAX_DISPUTE_WINDOW_SECS + SLASH_CEILING_PAST_POST_SETTLE_SECS;

export function cooldownFloorSecs(payWindowSecs: number, confirmWindowSecs: number): number {
  return payWindowSecs + confirmWindowSecs + LONGEST_TAIL_PAST_SETTLEMENT_SECS + 1;
}

export const CONTRACT_LIMIT_SOURCE = 'contracts/escrow/src/lib.rs';

export function windowsFitTheContract(
  payWindowSecs: number,
  confirmWindowSecs: number,
  disputeWindowSecs: number,
  deployedCooldownSecs?: number,
): string | null {
  if (payWindowSecs < MIN_USABLE_PAY_WINDOW_SECS) {
    return `payWindowSecs must be at least ${MIN_USABLE_PAY_WINDOW_SECS}, because the contract refuses a funding signature inside the last ${MIN_PAY_WINDOW_SECS} seconds of the window`;
  }
  if (payWindowSecs > MAX_PAY_WINDOW_SECS) {
    return `payWindowSecs must be at most ${MAX_PAY_WINDOW_SECS}`;
  }
  const total = payWindowSecs + confirmWindowSecs + disputeWindowSecs;
  if (total > MAX_TOTAL_WINDOW_SECS) {
    return `payWindowSecs + confirmWindowSecs + disputeWindowSecs must be at most ${MAX_TOTAL_WINDOW_SECS} (got ${total})`;
  }
  if (deployedCooldownSecs !== undefined) {
    const floor = cooldownFloorSecs(payWindowSecs, confirmWindowSecs);
    if (deployedCooldownSecs < floor) {
      return `these windows need the staking cooldown to be at least ${floor} seconds, but the deployed contract runs ${deployedCooldownSecs}`;
    }
  }
  return null;
}
