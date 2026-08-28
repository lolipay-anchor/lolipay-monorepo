import { DiditRefusalsService } from './didit-refusals.service';

describe('a delivery the anchor could not act on is counted until one it could', () => {
  it('reports nothing when nothing was refused', () => {
    expect(new DiditRefusalsService().state()).toMatchObject({ count: 0, lastReason: undefined });
  });

  it('counts refusals and keeps the most recent reason', () => {
    const s = new DiditRefusalsService();
    s.record('signature does not match the bytes that arrived');
    s.record('no webhook secret is configured');
    expect(s.state()).toMatchObject({ count: 2, lastReason: 'no webhook secret is configured' });
  });

  it('keeps reporting while the failure is still running, rather than clearing on a quiet minute', () => {
    const s = new DiditRefusalsService();
    s.record('anything');
    expect(s.state().count).toBe(1);
    expect(s.state().count).toBe(1);
  });

  it('clears only when a delivery is finally acted on', () => {
    const s = new DiditRefusalsService();
    s.record('anything');
    s.applied();
    expect(s.state()).toMatchObject({ count: 0, lastReason: undefined });
  });
});

describe('each kind of failure clears on its own terms, and never on somebody else s', () => {
  it('does not let one success declare a running outage over', () => {
    const s = new DiditRefusalsService();
    for (let i = 0; i < 5; i += 1) s.providerFailed('identity verification could not be started');
    s.providerAnswered();
    expect(s.state().providerFailures).toBe(4);
  });

  it('forgets a provider outage once as many sessions have succeeded as failed', () => {
    const s = new DiditRefusalsService();
    s.providerFailed('identity verification could not be started');
    s.providerAnswered();
    expect(s.state().providerFailures).toBe(0);
    expect(s.state().providerReason).toBeUndefined();
  });

  it('lets a stranger s probe fade rather than latching an alert for the life of the process', () => {
    const s = new DiditRefusalsService();
    s.couldNotAuthenticate('signature does not match the bytes that arrived');
    expect(s.state().unauthenticated).toBe(1);
    s.seen();
    expect(s.state().unauthenticated).toBe(0);
    expect(s.state().unauthenticatedReason).toBeUndefined();
  });

  it('does not let a delivery it acted on erase an outage or a probe', () => {
    const s = new DiditRefusalsService();
    s.providerFailed('identity verification could not be started');
    s.couldNotAuthenticate('signature does not match the bytes that arrived');
    s.budgetExhausted('this anchor has spent its whole budget');
    s.applied();
    expect(s.state().providerFailures).toBe(1);
    expect(s.state().unauthenticated).toBe(1);
    expect(s.state().overBudget).toBe(1);
  });

  it('clears the ceiling only when spending is possible again', () => {
    const s = new DiditRefusalsService();
    s.budgetExhausted('this anchor has spent its whole budget');
    s.applied();
    s.seen();
    expect(s.state().overBudget).toBe(1);
    s.spendResumed();
    expect(s.state().overBudget).toBe(0);
    expect(s.state().budgetReason).toBeUndefined();
  });
});
