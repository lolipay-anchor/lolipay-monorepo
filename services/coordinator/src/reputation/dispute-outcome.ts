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
