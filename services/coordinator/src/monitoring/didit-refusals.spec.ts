import { DiditRefusalsService } from './didit-refusals.service';

describe('a delivery the anchor could not act on is counted until one it could', () => {
  it('reports nothing when nothing was refused', () => {
    expect(new DiditRefusalsService().state()).toEqual({ count: 0, lastReason: undefined });
  });

  it('counts refusals and keeps the most recent reason', () => {
    const s = new DiditRefusalsService();
    s.record('signature does not match the bytes that arrived');
    s.record('no webhook secret is configured');
    expect(s.state()).toEqual({ count: 2, lastReason: 'no webhook secret is configured' });
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
    expect(s.state()).toEqual({ count: 0, lastReason: undefined });
  });
});
