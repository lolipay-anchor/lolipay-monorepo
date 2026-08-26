export type Resolution = 'released' | 'refunded';

export function userLostDispute(flow: string, resolution: Resolution): boolean {
  return (
    (flow === 'TOP_UP' && resolution === 'refunded') ||
    (flow === 'WITHDRAW' && resolution === 'released')
  );
}

export function providerLostDispute(flow: string, resolution: Resolution): boolean {
  return (
    (flow === 'TOP_UP' && resolution === 'released') ||
    (flow === 'WITHDRAW' && resolution === 'refunded')
  );
}

export type LostWhere = { flow: 'TOP_UP' | 'WITHDRAW'; resolution: Resolution };

export const PROVIDER_LOST_WHERE: LostWhere[] = [
  { flow: 'TOP_UP', resolution: 'released' },
  { flow: 'WITHDRAW', resolution: 'refunded' },
];

export const USER_LOST_WHERE: LostWhere[] = [
  { flow: 'TOP_UP', resolution: 'refunded' },
  { flow: 'WITHDRAW', resolution: 'released' },
];
