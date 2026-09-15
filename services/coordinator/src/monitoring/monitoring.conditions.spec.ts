import {
  ALERT_SAMPLE_LIMIT,
  ALERT_TEXT_BUDGET,
  alertAgeSentence,
  fiatPaymentOverdueWhere,
  humanDuration,
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

describe('humanDuration rounds an elapsed time to one sensible unit', () => {
  it('reads as moments rather than "0 seconds" right at the start', () => {
    expect(humanDuration(0)).toBe('moments');
    expect(humanDuration(999)).toBe('moments');
  });

  it('never prints a fraction: whole seconds under a minute', () => {
    expect(humanDuration(45_000)).toBe('45 seconds');
  });

  it('does not say "1 seconds" — singular gets the same treatment as every other unit', () => {
    expect(humanDuration(1000)).toBe('1 second');
  });

  it('rolls over to minutes, singular and plural', () => {
    expect(humanDuration(60_000)).toBe('1 minute');
    expect(humanDuration(5 * 60_000)).toBe('5 minutes');
  });

  it('rolls over to hours, singular and plural', () => {
    expect(humanDuration(60 * 60_000)).toBe('1 hour');
    expect(humanDuration(3 * 60 * 60_000)).toBe('3 hours');
  });

  it('rolls over to days, singular and plural, and does not report raw seconds for a six-day outage', () => {
    expect(humanDuration(24 * 60 * 60_000)).toBe('1 day');
    expect(humanDuration(6 * 24 * 60 * 60_000)).toBe('6 days');
  });

  it('floors rather than rounds up, so it never claims more time has passed than actually has', () => {
    expect(humanDuration(119_000)).toBe('1 minute');
    expect(humanDuration(6 * 24 * 60 * 60_000 - 1000)).toBe('5 days');
  });

  it('clamps a negative elapsed time to moments instead of printing a huge or negative figure', () => {
    expect(humanDuration(-500_000)).toBe('moments');
  });
});

describe('alertAgeSentence states how long a condition has been true and how many times it was sent', () => {
  const NOW = new Date('2026-09-15T12:00:00Z').getTime();

  it('reads sensibly on the very first occurrence, not "for 0 seconds"', () => {
    const text = alertAgeSentence({ kind: 'first' }, NOW);
    expect(text).not.toMatch(/0 seconds/);
    expect(text.length).toBeGreaterThan(0);
  });

  it('states the age and the send count from a persisted row, so a six-day-old alert says so', () => {
    const sixDaysAgo = new Date(NOW - 6 * 24 * 60 * 60 * 1000);
    const text = alertAgeSentence(
      { kind: 'known', firstSeenAt: sixDaysAgo, sendCount: 29 },
      NOW,
    );
    expect(text).toContain('6 days');
    expect(text).toContain('29');
  });

  it('says the count is BEFORE this send, so it never reads as a total that includes the message being read', () => {
    const text = alertAgeSentence({ kind: 'known', firstSeenAt: new Date(NOW - 60_000), sendCount: 29 }, NOW);
    expect(text).toMatch(/29 times before this one/);
  });

  it('does not say "1 times" — singular gets the same treatment as every other count', () => {
    const text = alertAgeSentence({ kind: 'known', firstSeenAt: new Date(NOW - 60_000), sendCount: 1 }, NOW);
    expect(text).toContain('1 time before this one');
    expect(text).not.toContain('1 times');
  });

  it('never turns a negative age (clock skew, or a row written in the future) into nonsense', () => {
    const future = new Date(NOW + 999_000);
    const text = alertAgeSentence({ kind: 'known', firstSeenAt: future, sendCount: 3 }, NOW);
    expect(text).not.toMatch(/-/);
    expect(text).toContain('3');
  });

  it('says the history could not be read, distinctly from saying the condition is new', () => {
    const text = alertAgeSentence({ kind: 'unreadable' }, NOW);
    expect(text).toMatch(/could not be read/);
    const freshText = alertAgeSentence({ kind: 'first' }, NOW);
    expect(text).not.toBe(freshText);
  });
});
