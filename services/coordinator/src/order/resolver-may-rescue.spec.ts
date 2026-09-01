import { ForbiddenException } from '@nestjs/common';
import { OrderTxService } from './order-tx.service';

const RESOLVER = 'GBDAT5C6MBMHCFEHERC6KRDTZUORG6W55D47HIPFVQS5DKMZKJPAFC3R';
const USER = 'GBCUZOOJ6W3BWPDW53QL3UDSXTGZNITUS32ZK7GE5ZQSLN7YUVOBHKJT';
const LP = 'GD2XB6Q3SQYGTCUPA5W357H4NNKQ2F4XGTILDM6EJH2F37YQOLOPTPP2';
const STRANGER = 'GAANO56LEGTZMZQLOLHYDJRY6CXUEYXDFT753MCSJMFROG5CLPLNS2TA';

function svc(opts: { resolver?: string; onChainCalls?: { n: number } } = {}) {
  const order = {
    id: 'o1',
    userAddress: USER,
    tradeId: 'ab'.repeat(32),
    status: 'FIAT_PAID',
    flow: 'WITHDRAW',
    lp: { stellarAddress: LP },
  };
  const stellar = {
    readEscrowResolver: jest.fn(async () => {
      if (opts.onChainCalls) opts.onChainCalls.n += 1;
      return opts.resolver ?? RESOLVER;
    }),
  };
  const status = {
    contractIdFor: () => 'CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z',
    refreshOrderStatus: jest.fn(async () => order),
  };
  const prisma = { order: { findUnique: jest.fn(async () => order) } };
  const s = new OrderTxService(prisma as any, stellar as any, {} as any, status as any);
  return { s, stellar };
}

describe('a stranded withdrawal has an advocate, and it is the escrow own resolver', () => {
  it('refuses a stranger, and only asks the chain because they were not a party', async () => {
    const calls = { n: 0 };
    const { s } = svc({ onChainCalls: calls });
    await expect(s.buildRaiseDisputeTx('o1', STRANGER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(s.buildRaiseDisputeTx('o1', STRANGER)).rejects.toThrow(
      /trade party or the escrow resolver/,
    );
    expect(calls.n).toBe(2);
  });

  it('names the resolver in the refusal, so an operator knows the door exists', async () => {
    const { s } = svc();
    await expect(s.buildRaiseDisputeTx('o1', STRANGER)).rejects.toThrow(/resolver/);
  });

  it('does not ask the chain at all when the caller is already a trade party', async () => {
    const calls = { n: 0 };
    const { s } = svc({ onChainCalls: calls });
    await s.buildRaiseDisputeTx('o1', USER).catch(() => undefined);
    await s.buildRaiseDisputeTx('o1', LP).catch(() => undefined);
    expect(calls.n).toBe(0);
  });

  it('ADMITS the resolver — the half that a refusal-only suite never proves', async () => {
    const calls = { n: 0 };
    const { s } = svc({ onChainCalls: calls });
    const status: any = (s as any).status;

    await s.buildRaiseDisputeTx('o1', RESOLVER).catch(() => undefined);

    expect(calls.n).toBe(1);
    expect(status.refreshOrderStatus).toHaveBeenCalledWith('o1', expect.anything());
  });

  it('does not reach the order state for a caller it refuses, so admission is what moved it on', async () => {
    const { s } = svc();
    const status: any = (s as any).status;
    await s.buildRaiseDisputeTx('o1', STRANGER).catch(() => undefined);
    expect(status.refreshOrderStatus).not.toHaveBeenCalled();
  });

  it('takes the resolver from the chain rather than a config value an operator could mistype', async () => {
    const { s, stellar } = svc({ resolver: STRANGER });
    await s.buildRaiseDisputeTx('o1', STRANGER).catch(() => undefined);
    expect(stellar.readEscrowResolver).toHaveBeenCalledWith(
      'CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z',
    );
  });
});
