import type { Sep24Status } from './sep24-status';

describe('the Sep24Status union admits pending_external before any reader can return it, ADR 0059', () => {
  it('type-checks pending_external as a member of Sep24Status', () => {
    const status: Sep24Status = 'pending_external';
    expect(status).toBe('pending_external');
  });
});
