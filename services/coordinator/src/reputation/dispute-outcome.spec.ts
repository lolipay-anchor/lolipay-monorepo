import {
  PROVIDER_LOST_WHERE,
  USER_LOST_WHERE,
  providerLostDispute,
  userLostDispute,
  Resolution,
} from './dispute-outcome';

const FLOWS = ['TOP_UP', 'WITHDRAW'];
const RESOLUTIONS: Resolution[] = ['released', 'refunded'];

describe('the filters the reputation queries use cannot drift from the rules they mean', () => {
  it('every combination the provider-lost filter names is one the rule agrees with', () => {
    for (const { flow, resolution } of PROVIDER_LOST_WHERE) {
      expect(providerLostDispute(flow, resolution)).toBe(true);
    }
  });

  it('every combination the user-lost filter names is one the rule agrees with', () => {
    for (const { flow, resolution } of USER_LOST_WHERE) {
      expect(userLostDispute(flow, resolution)).toBe(true);
    }
  });

  it('neither filter leaves out a combination its rule would catch', () => {
    for (const flow of FLOWS) {
      for (const resolution of RESOLUTIONS) {
        const named = (list: { flow: string; resolution: Resolution }[]) =>
          list.some((e) => e.flow === flow && e.resolution === resolution);
        expect(named(PROVIDER_LOST_WHERE)).toBe(providerLostDispute(flow, resolution));
        expect(named(USER_LOST_WHERE)).toBe(userLostDispute(flow, resolution));
      }
    }
  });

  it('the two are exclusive: one verdict never loses for both parties', () => {
    for (const flow of FLOWS) {
      for (const resolution of RESOLUTIONS) {
        expect(providerLostDispute(flow, resolution) && userLostDispute(flow, resolution)).toBe(
          false,
        );
      }
    }
  });
});
