export const MIN_PAY_WINDOW_SECS = 600;
export const MAX_PAY_WINDOW_SECS = 86_400;
export const MAX_TOTAL_WINDOW_SECS = 2_592_000;

export const CONTRACT_LIMIT_SOURCE = 'contracts/escrow/src/lib.rs';

export function windowsFitTheContract(
  payWindowSecs: number,
  confirmWindowSecs: number,
  disputeWindowSecs: number,
): string | null {
  if (payWindowSecs < MIN_PAY_WINDOW_SECS) {
    return `payWindowSecs must be at least ${MIN_PAY_WINDOW_SECS}`;
  }
  if (payWindowSecs > MAX_PAY_WINDOW_SECS) {
    return `payWindowSecs must be at most ${MAX_PAY_WINDOW_SECS}`;
  }
  const total = payWindowSecs + confirmWindowSecs + disputeWindowSecs;
  if (total > MAX_TOTAL_WINDOW_SECS) {
    return `payWindowSecs + confirmWindowSecs + disputeWindowSecs must be at most ${MAX_TOTAL_WINDOW_SECS} (got ${total})`;
  }
  return null;
}
