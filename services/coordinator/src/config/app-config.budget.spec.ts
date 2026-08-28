import { AppConfigService } from './app-config.service';

const cfg = (v?: string) =>
  new AppConfigService({ get: (k: string) => (k === 'DIDIT_DAILY_SESSION_BUDGET' ? v : undefined) } as any);

describe('the anchor never spends without a ceiling it can name', () => {
  it('has a ceiling even when nobody configured one', () => {
    expect(cfg(undefined).diditDailySessionBudget).toBe(200);
  });

  it('takes the configured ceiling when it is a sane number', () => {
    expect(cfg('25').diditDailySessionBudget).toBe(25);
  });

  it('refuses a ceiling of zero or nonsense rather than reading it as no limit', () => {
    expect(cfg('0').diditDailySessionBudget).toBe(200);
    expect(cfg('-5').diditDailySessionBudget).toBe(200);
    expect(cfg('banyak').diditDailySessionBudget).toBe(200);
  });
});
