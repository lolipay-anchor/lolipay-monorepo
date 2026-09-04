import { orderTxFor } from './test-helpers';

const USER = 'GUSER';
const LP = 'GLP';

function svcWith(flow: 'TOP_UP' | 'WITHDRAW') {
  const order = {
    id: 'order-1',
    tradeId: 'a'.repeat(64),
    contractId: 'CTEST',
    userAddress: USER,
    flow,
    status: 'FUNDED',
    fiatCurrency: 'IDR',
    usdcAmount: 100000000n,
    fiatAmount: 1600000n,
    rateSnapshot: '16000',
    platformFeeBps: 30,
    lpFeeBps: 120,
    platformWallet: 'GPLATFORM',
    lpWallet: LP,
    lpId: 'lp1',
    lp: { stellarAddress: LP },
    payDeadline: 4_000_000_000n,
    confirmDeadline: 4_000_003_600n,
    disputeDeadline: 4_000_009_000n,
    rail: 'BANK',
    proofUrl: 'https://proof',
    expiresAt: new Date(3_999_999_400_000),
    createdAt: new Date(),
  };
  const prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue({ ...order }),
      update: jest.fn().mockResolvedValue({ ...order }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([order]),
      count: jest.fn().mockResolvedValue(0),
    },
    config: { upsert: jest.fn().mockResolvedValue({ id: 1, requireProof: false }) },
    lp: { findUnique: jest.fn() },
  } as any;
  const stellar = {
    buildMarkFiatPaidTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
    getTradeStatus: jest.fn().mockResolvedValue(null),
    getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'FUNDED' }),
  } as any;
  return { svc: orderTxFor(prisma, stellar, { platformWallet: 'GPLATFORM', escrowContractId: 'CENV' } as any), stellar };
}

describe('the mark-paid bound is the deadline the contract holds this caller to', () => {
  it('a depositing user is bounded by the pay deadline', async () => {
    const { svc, stellar } = svcWith('TOP_UP');
    await svc.buildMarkFiatPaidTx('order-1', USER);
    expect(stellar.buildMarkFiatPaidTx).toHaveBeenCalledWith('CTEST', USER, 'a'.repeat(64), 4_000_000_000);
  });

  it('a paying provider on a withdrawal is bounded by the confirm deadline', async () => {
    const { svc, stellar } = svcWith('WITHDRAW');
    await svc.buildMarkFiatPaidTx('order-1', LP);
    expect(stellar.buildMarkFiatPaidTx).toHaveBeenCalledWith('CTEST', LP, 'a'.repeat(64), 4_000_003_600);
  });
});
