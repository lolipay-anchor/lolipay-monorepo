import { Account } from '@stellar/stellar-sdk';
import { StellarReadService } from './stellar-read.service';
import { signingDeadlineSecs } from '../config/contract-limits';

const SOURCE = 'GBEIUZUZ625KNMPNMKX7HSF2GPXZRD6CL7OUH7JD5CQQXNTTKLZNMSIA';
const CONTRACT = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';

function harness() {
  const svc = new StellarReadService({
    rpcUrl: 'x',
    networkPassphrase: 'Test SDF Network ; September 2015',
    stakingContractId: CONTRACT,
    escrowContractId: CONTRACT,
  } as any);
  const built: any[] = [];
  (svc as any).createRpcServer = () => ({
    getAccount: async () => new Account(SOURCE, '1'),
    prepareTransaction: async (tx: any) => {
      built.push(tx);
      return { toXdr: () => 'prepared' };
    },
  });
  return { svc, built };
}

function params(payDeadline: number) {
  return {
    contractId: CONTRACT,
    tradeIdHex: 'ab'.repeat(32),
    usdcProvider: SOURCE,
    usdcRecipient: SOURCE,
    confirmer: SOURCE,
    usdcAmount: 1n,
    fiatAmount: 1n,
    fiatCurrency: 'IDR',
    flow: 'WITHDRAW' as const,
    platformFeeBps: 30,
    lpFeeBps: 120,
    platformWallet: SOURCE,
    lpWallet: SOURCE,
    payDeadline: BigInt(payDeadline),
    confirmDeadline: BigInt(payDeadline + 1800),
    disputeDeadline: BigInt(payDeadline + 9000),
  };
}

describe('the funding transaction expires on its own at the last instant the escrow would accept it, so a late signature is refused without a fee', () => {
  it('caps maxTime at payDeadline minus the contract minimum when that comes before the usual five minutes', async () => {
    const { svc, built } = harness();
    const now = Math.floor(Date.now() / 1000);
    await svc.buildCreateTradeTx(params(now + 700));
    expect(Number(built[0].timeBounds.maxTime)).toBe(signingDeadlineSecs(now + 700));
  });

  it('keeps the usual five-minute bound when the deadline is far away', async () => {
    const { svc, built } = harness();
    const now = Math.floor(Date.now() / 1000);
    await svc.buildCreateTradeTx(params(now + 86_400));
    const maxTime = Number(built[0].timeBounds.maxTime);
    expect(maxTime).toBeGreaterThanOrEqual(now + 299);
    expect(maxTime).toBeLessThanOrEqual(now + 301);
  });
});
