import { DiditRefusalsService } from './didit-refusals.service';

describe('a refused delivery is counted so somebody can be told', () => {
  it('reports nothing when nothing was refused', () => {
    expect(new DiditRefusalsService().drain()).toEqual({ count: 0, lastReason: undefined });
  });

  it('counts refusals and keeps the most recent reason', () => {
    const s = new DiditRefusalsService();
    s.record('signature does not match the bytes that arrived');
    s.record('no webhook secret is configured');
    expect(s.drain()).toEqual({ count: 2, lastReason: 'no webhook secret is configured' });
  });

  it('starts from nothing once drained, so an alert clears instead of repeating forever', () => {
    const s = new DiditRefusalsService();
    s.record('anything');
    s.drain();
    expect(s.drain()).toEqual({ count: 0, lastReason: undefined });
  });
});
