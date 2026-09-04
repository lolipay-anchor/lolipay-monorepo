import { computeWindows } from './order.service';
import { MIN_PAY_WINDOW_SECS } from '../config/contract-limits';

describe('the order expiry the coordinator sweeps on is the last instant the escrow accepts the funding signature', () => {
  const windows = { payWindowSecs: 1800, confirmWindowSecs: 1800, disputeWindowSecs: 7200 };

  it('expires the order MIN_PAY_WINDOW before the pay deadline, because create_trade refuses a pay deadline closer than that', () => {
    const w = computeWindows(windows);
    expect(w.expiresAt.getTime()).toBe((w.payDeadline - MIN_PAY_WINDOW_SECS) * 1000);
    expect(w.expiresAt.getTime()).toBeLessThan(w.payDeadline * 1000);
  });

  it('keeps the on-chain deadlines themselves untouched: pay, then confirm, then dispute, each window added in turn', () => {
    const w = computeWindows(windows);
    const now = Math.floor(Date.now() / 1000);
    expect(w.payDeadline - now).toBeGreaterThanOrEqual(1799);
    expect(w.payDeadline - now).toBeLessThanOrEqual(1801);
    expect(w.confirmDeadline).toBe(w.payDeadline + 1800);
    expect(w.disputeDeadline).toBe(w.confirmDeadline + 7200);
  });
});
