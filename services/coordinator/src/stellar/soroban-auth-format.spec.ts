import * as fs from 'fs';
import * as path from 'path';
import { Account } from '@stellar/stellar-sdk';
import { StellarReadService } from './stellar-read.service';

const SOURCE = 'GBEIUZUZ625KNMPNMKX7HSF2GPXZRD6CL7OUH7JD5CQQXNTTKLZNMSIA';
const CONTRACT = 'CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K';
const TRADE_ID = 'ab'.repeat(32);

function makeSvc() {
  return new StellarReadService({
    rpcUrl: 'x',
    networkPassphrase: 'Test SDF Network ; September 2015',
    stakingContractId: CONTRACT,
    escrowContractId: CONTRACT,
  } as any);
}

function recordPrepare(svc: StellarReadService) {
  const calls: unknown[][] = [];
  (svc as any).createRpcServer = () => ({
    getAccount: async () => new Account(SOURCE, '1'),
    prepareTransaction: async (...args: unknown[]) => {
      calls.push(args);
      return { toXdr: () => 'prepared' };
    },
  });
  return calls;
}

describe('Soroban authorisation format', () => {
  it('asks for legacy v1 address credentials when preparing a create_trade', async () => {
    const svc = makeSvc();
    const calls = recordPrepare(svc);

    await svc.buildCreateTradeTx({
      contractId: CONTRACT,
      tradeIdHex: TRADE_ID,
      usdcProvider: SOURCE,
      usdcRecipient: SOURCE,
      confirmer: SOURCE,
      usdcAmount: 1n,
      fiatAmount: 1n,
      fiatCurrency: 'IDR',
      flow: 'TOP_UP',
      platformFeeBps: 30,
      lpFeeBps: 120,
      platformWallet: SOURCE,
      lpWallet: SOURCE,
      payDeadline: 1n,
      confirmDeadline: 2n,
      disputeDeadline: 3n,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe(false);
  });

  it('asks for legacy v1 address credentials when preparing a mark_fiat_paid', async () => {
    const svc = makeSvc();
    const calls = recordPrepare(svc);

    await svc.buildMarkFiatPaidTx(CONTRACT, SOURCE, TRADE_ID);

    expect(calls[0][1]).toBe(false);
  });

  it('asks for legacy v1 address credentials when preparing a stake', async () => {
    const svc = makeSvc();
    const calls = recordPrepare(svc);

    await svc.buildStakeTx(SOURCE, '1');

    expect(calls[0][1]).toBe(false);
  });

  it('leaves no prepareTransaction call that takes the SDK default', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'stellar-read.service.ts'),
      'utf8',
    );
    const prepared = source.match(/server\.prepareTransaction\([^)]*\)/g) ?? [];

    expect(source).toMatch(/const USE_UPGRADED_SOROBAN_AUTH = false;/);
    expect(prepared.length).toBeGreaterThanOrEqual(9);
    for (const call of prepared) {
      expect(call).toBe('server.prepareTransaction(tx, USE_UPGRADED_SOROBAN_AUTH)');
    }
  });
});
