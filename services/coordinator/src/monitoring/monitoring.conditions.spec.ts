import {
  ALERT_SAMPLE_LIMIT,
  ALERT_TEXT_BUDGET,
  fiatPaymentOverdueWhere,
  openDisputesWhere,
  releaseOverdueWhere,
} from './monitoring.conditions';

describe('the conditions an operator is alerted about', () => {
  const NOW = 1_700_000_000n;

  it('an open dispute is one that is disputed, not one that settled', () => {
    expect(openDisputesWhere()).toEqual({ status: 'DISPUTED' });
  });

  it('release is overdue when the confirm deadline is behind us, not ahead', () => {
    expect(releaseOverdueWhere(NOW)).toEqual({
      status: 'FIAT_PAID',
      confirmDeadline: { lt: NOW },
    });
  });

  it('fiat is overdue on a funded trade, and each flow is judged by its own deadline', () => {
    const w = fiatPaymentOverdueWhere(NOW) as any;
    expect(w.status).toBe('FUNDED');
    expect(w.OR).toEqual([
      { flow: 'TOP_UP', payDeadline: { lt: NOW } },
      { flow: 'WITHDRAW', confirmDeadline: { lt: NOW } },
    ]);
  });

  it('neither flow is quietly dropped from the overdue check', () => {
    const flows = (fiatPaymentOverdueWhere(NOW) as any).OR.map((c: any) => c.flow);
    expect(flows).toContain('TOP_UP');
    expect(flows).toContain('WITHDRAW');
  });

  it('the sample is bounded and the message budget fits inside what a webhook accepts', () => {
    expect(ALERT_SAMPLE_LIMIT).toBeGreaterThan(0);
    expect(ALERT_TEXT_BUDGET).toBeGreaterThan(0);
    expect(ALERT_TEXT_BUDGET).toBeLessThan(2000);
  });
});
