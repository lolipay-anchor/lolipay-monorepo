import { Sep24Service } from './sep24.service';
import { randomBytes } from 'node:crypto';
import { mintInteractiveToken } from './interactive-token';

const cfg: any = { jwtSecret: randomBytes(32).toString('hex'), jwtIssuer: 'lolipay-test' };

function serviceWith(orderStatus: string, refreshed: any) {
  const seen: any[] = [];
  const row = {
    id: 'tx-1',
    orderId: 'order-1',
    stellarAccount: 'GUSER',
    personId: 'person-1',
    flow: 'WITHDRAW',
    order: { id: 'order-1', status: orderStatus },
  };
  const prisma: any = {
    sep24Transaction: { findUnique: async () => row },
    order: {
      findUnique: async () => ({
        id: 'order-1',
        status: orderStatus,
        tradeId: 'a'.repeat(64),
        contractId: 'CESCROW',
        flow: 'WITHDRAW',
        userAddress: 'GUSER',
        lpWallet: 'GLP',
        lp: { stellarAddress: 'GLP' },
      }),
    },
    kycVerification: { findUnique: async () => null, findFirst: async () => null },
  };
  const orderStatusService: any = {
    refreshOrderStatus: async (id: string, order: any) => {
      seen.push({ id, order });
      return refreshed;
    },
  };
  const people: any = { lookupPerson: async () => ({ id: 'person-1' }) };
  const service = new Sep24Service(
    prisma,
    cfg,
    {} as any,
    {} as any,
    {} as any,
    people,
    {} as any,
    orderStatusService,
    { isConfigured: false } as any,
  );
  return { service, seen };
}

describe('the interactive page asks the chain, not only the row it holds', () => {
  const token = () => mintInteractiveToken(cfg, 'tx-1', 'GUSER');

  it('refreshes a FUNDED order from chain, so the confirm button appears without waiting on the indexer', async () => {
    const { service, seen } = serviceWith('FUNDED', { id: 'order-1', status: 'FIAT_PAID' });
    const state = await service.interactiveState('tx-1', token());
    expect(seen).toHaveLength(1);
    expect((state.row.order as any).status).toBe('FIAT_PAID');
  });

  it('hands it an order carrying the tradeId, without which the chain lookup silently finds nothing', async () => {
    const { service, seen } = serviceWith('FUNDED', { id: 'order-1', status: 'FUNDED' });
    await service.interactiveState('tx-1', token());
    expect(seen[0].order.tradeId).toBe('a'.repeat(64));
    expect(seen[0].order.contractId).toBe('CESCROW');
    expect(seen[0].order.lpWallet).toBe('GLP');
    expect(seen[0].id).toBe('order-1');
  });

  it('does not spend an RPC call on a status the chain can no longer move', async () => {
    const { service, seen } = serviceWith('RELEASED', { id: 'order-1', status: 'RELEASED' });
    const state = await service.interactiveState('tx-1', token());
    expect(seen).toHaveLength(0);
    expect((state.row.order as any).status).toBe('RELEASED');
  });

  it('still renders from the row it holds when the chain read fails', async () => {
    const { service } = serviceWith('FUNDED', null);
    const boom: any = service as any;
    boom.orderStatus = {
      refreshOrderStatus: async () => {
        throw new Error('rpc is down');
      },
    };
    const state = await service.interactiveState('tx-1', token());
    expect((state.row.order as any).status).toBe('FUNDED');
  });
});
