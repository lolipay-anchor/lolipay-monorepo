import { stillInFlight } from './sep12.service';

describe('a verification session is in flight for one day from its last movement', () => {
  const now = 1_800_000_000_000;
  let clock: jest.SpyInstance;

  beforeEach(() => {
    clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(() => {
    clock.mockRestore();
  });

  const row = (over: Record<string, unknown>) => ({ status: 'PROCESSING', providerRef: 'sess-1', updatedAt: new Date(now - 60_000), ...over });

  it('is in flight just inside a day and stale just past it', () => {
    expect(stillInFlight(row({ updatedAt: new Date(now - (24 * 60 * 60 * 1000 - 60_000)) }))).toBe(true);
    expect(stillInFlight(row({ updatedAt: new Date(now - (24 * 60 * 60 * 1000 + 60_000)) }))).toBe(false);
  });

  it('is in flight when nothing ever stamped it, so an unstamped row pins rather than reopens', () => {
    expect(stillInFlight(row({ updatedAt: null }))).toBe(true);
  });

  it('is never in flight without a session, whatever the age', () => {
    expect(stillInFlight(row({ providerRef: null }))).toBe(false);
    expect(stillInFlight(row({ providerRef: '' }))).toBe(false);
  });

  it('is never in flight for a row that is not processing', () => {
    expect(stillInFlight(row({ status: 'ACCEPTED' }))).toBe(false);
    expect(stillInFlight(row({ status: 'NEEDS_INFO' }))).toBe(false);
    expect(stillInFlight(null)).toBe(false);
    expect(stillInFlight(undefined)).toBe(false);
  });
});
