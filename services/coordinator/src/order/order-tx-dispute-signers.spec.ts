import { orderTxFor } from './test-helpers';

const USER = 'GUSER';
const LP = 'GLP';
const RESOLVER = 'GRESOLVER';
const ADMIN = 'GADMIN';
const FOUNDER_WALLET = 'GFOUNDER';

function svcWith(status: 'DISPUTED' | 'REFUNDED', signers: { resolver: string; admin: string } | Error = { resolver: RESOLVER, admin: ADMIN }) {
  const order = {
    id: 'order-1',
    tradeId: 'a'.repeat(64),
    contractId: 'CTEST',
    userAddress: USER,
    flow: 'TOP_UP',
    status,
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
    settledAt: new Date(),
  };
  const prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue({ ...order }),
      update: jest.fn().mockResolvedValue({ ...order }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([order]),
      count: jest.fn().mockResolvedValue(0),
    },
    config: { upsert: jest.fn().mockResolvedValue({ id: 1, requireProof: false, postSettleDisputeWindowSecs: 7200 }) },
    lp: { findUnique: jest.fn() },
  } as any;
  const stellar = {
    readDisputeSigners: signers instanceof Error ? jest.fn().mockRejectedValue(signers) : jest.fn().mockResolvedValue(signers),
    buildResolveTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
    buildSlashTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
    getTradeStatus: jest.fn().mockResolvedValue(null),
    getTradeStatusStrict: jest.fn().mockResolvedValue({ status: 'REFUNDED', liabilityEstablished: true, slashDeadline: 4_000_009_000n }),
  } as any;
  return {
    svc: orderTxFor(prisma, stellar, { platformWallet: 'GPLATFORM', escrowContractId: 'CENV', stakingContractId: 'CSTAKING' } as any),
    stellar,
  };
}

describe('a dispute is settled only by the wallet the contract names', () => {
  it('builds the resolve transaction for the resolver', async () => {
    const { svc, stellar } = svcWith('DISPUTED');
    await svc.buildResolveTx('order-1', RESOLVER, 'release');
    expect(stellar.readDisputeSigners).toHaveBeenCalledWith('CTEST');
    expect(stellar.buildResolveTx).toHaveBeenCalledWith('CTEST', RESOLVER, 'a'.repeat(64), 'release');
  });

  it('builds the resolve transaction for the admin, who the contract admits after the resolver window', async () => {
    const { svc, stellar } = svcWith('DISPUTED');
    await svc.buildResolveTx('order-1', ADMIN, 'refund');
    expect(stellar.buildResolveTx).toHaveBeenCalledWith('CTEST', ADMIN, 'a'.repeat(64), 'refund');
  });

  it('refuses a resolve for any other wallet, naming the two the contract accepts, before building anything', async () => {
    const { svc, stellar } = svcWith('DISPUTED');
    await expect(svc.buildResolveTx('order-1', FOUNDER_WALLET, 'release')).rejects.toThrow(
      `the escrow lets only its resolver ${RESOLVER} settle this dispute, or its admin ${ADMIN} once the resolver's day has passed; ${FOUNDER_WALLET} is neither`,
    );
    expect(stellar.buildResolveTx).not.toHaveBeenCalled();
  });

  it('refuses a resolve when the signers cannot be read, rather than handing out a transaction the contract will reject', async () => {
    const { svc, stellar } = svcWith('DISPUTED', new Error('fetch failed'));
    await expect(svc.buildResolveTx('order-1', RESOLVER, 'release')).rejects.toThrow(/cannot read who may settle/);
    expect(stellar.buildResolveTx).not.toHaveBeenCalled();
  });

  it('checks the staking contract, not the escrow, before a slash, and refuses a wallet it does not name', async () => {
    const { svc, stellar } = svcWith('REFUNDED');
    await expect(svc.buildSlashTx('order-1', FOUNDER_WALLET, 1n)).rejects.toThrow(/is neither/);
    expect(stellar.readDisputeSigners).toHaveBeenCalledWith('CSTAKING');
    expect(stellar.getTradeStatusStrict).not.toHaveBeenCalled();
    expect(stellar.buildSlashTx).not.toHaveBeenCalled();
  });
});
