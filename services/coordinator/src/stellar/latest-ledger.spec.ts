import { StellarReadService } from './stellar-read.service';

function svcWith(getLatestLedger: () => Promise<any>) {
  const svc = new StellarReadService({ rpcUrl: 'x', networkPassphrase: 'Test SDF Network ; September 2015' } as any);
  (svc as any).createRpcServer = () => ({ getLatestLedger });
  return svc;
}

describe('latestLedgerCloseTime reads the close time the RPC reports, and refuses to guess when it cannot', () => {
  it('turns the unix-seconds string the RPC sends into a Date', async () => {
    const svc = svcWith(async () => ({ id: 'x', sequence: 1, protocolVersion: 22, closeTime: '1788537912' }));
    expect((await svc.latestLedgerCloseTime()).toISOString()).toBe('2026-09-04T16:05:12.000Z');
  });

  it('throws naming the field when the close time is missing or unreadable, rather than yielding an Invalid Date the sweeper would act on', async () => {
    await expect(svcWith(async () => ({ id: 'x', sequence: 1 })).latestLedgerCloseTime()).rejects.toThrow(/closeTime/);
    await expect(svcWith(async () => ({ closeTime: 'abc' })).latestLedgerCloseTime()).rejects.toThrow(/closeTime/);
  });
});
