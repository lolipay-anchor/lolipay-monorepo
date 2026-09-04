import { ConflictException } from '@nestjs/common';
import { orderTxFor } from './test-helpers';

const USER = 'GUSER';
const LP = 'GLP';

function svcWith(payDeadlineSecs: number) {
  const order = {
    id: 'order-1',
    tradeId: 'a'.repeat(64),
    contractId: 'CTEST',
    userAddress: USER,
    flow: 'WITHDRAW',
    status: 'MATCHED',
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
    payDeadline: BigInt(payDeadlineSecs),
    confirmDeadline: BigInt(payDeadlineSecs + 1800),
    disputeDeadline: BigInt(payDeadlineSecs + 9000),
    rail: 'BANK',
    expiresAt: new Date((payDeadlineSecs - 600) * 1000),
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
    buildCreateTradeTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
    getTradeStatus: jest.fn().mockResolvedValue(null),
    getTradeStatusStrict: jest.fn().mockResolvedValue(null),
  } as any;
  return { svc: orderTxFor(prisma, stellar, { platformWallet: 'GPLATFORM', escrowContractId: 'CENV' } as any), stellar };
}

describe('the funding build refuses once the signing window has closed, so the user hears it in plain words rather than as a contract error', () => {
  it('refuses a MATCHED order inside the last ten minutes before its pay deadline, the span the contract refuses, before any transaction is built', async () => {
    const { svc, stellar } = svcWith(Math.floor(Date.now() / 1000) + 599);
    await expect(svc.buildCreateTradeTx('order-1', USER)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.buildCreateTradeTx('order-1', USER)).rejects.toThrow(/signing window/i);
    expect(stellar.buildCreateTradeTx).not.toHaveBeenCalled();
  });

  it('builds while the window is open', async () => {
    const { svc, stellar } = svcWith(Math.floor(Date.now() / 1000) + 1800);
    await expect(svc.buildCreateTradeTx('order-1', USER)).resolves.toEqual({ xdr: 'x', networkPassphrase: 'p' });
    expect(stellar.buildCreateTradeTx).toHaveBeenCalledTimes(1);
  });
});
