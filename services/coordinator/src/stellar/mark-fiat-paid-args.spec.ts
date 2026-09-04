import { Account, Address, Keypair, scValToNative } from '@stellar/stellar-sdk';
import { StellarReadService } from './stellar-read.service';

const CONTRACT = 'CD2OHPGEJPZGV5JQJUV6C3HTU274HPIFR2SCV4TKMJM3J3YXEIB4GFOO';
const TRADE_ID = 'ab'.repeat(32);
const CALLER = Keypair.random().publicKey();

function makeSvc() {
  return new StellarReadService({
    rpcUrl: 'x',
    networkPassphrase: 'Test SDF Network ; September 2015',
    stakingContractId: 'C',
    escrowContractId: CONTRACT,
  } as any);
}

async function invokedArgs(caller = CALLER) {
  const svc = makeSvc();
  let seenOp: any;
  (svc as any).createRpcServer = () => ({
    getAccount: jest.fn().mockResolvedValue(new Account(caller, '100')),
    prepareTransaction: jest.fn(async (tx: any) => {
      seenOp = tx.operations[0];
      return { toXdr: () => 'prepared' };
    }),
  });

  await svc.buildMarkFiatPaidTx(CONTRACT, caller, TRADE_ID, Math.floor(Date.now() / 1000) + 1800);
  return seenOp.func.invokeContract.args;
}

describe('mark_fiat_paid is invoked with the arguments the contract now takes', () => {
  it('passes both the trade id and the caller', async () => {
    const args = await invokedArgs();

    expect(args).toHaveLength(2);
  });

  it('passes the trade id first, unchanged', async () => {
    const args = await invokedArgs();

    expect(Buffer.from(scValToNative(args[0]) as Uint8Array).toString('hex')).toBe(TRADE_ID);
  });

  it('passes the caller second, as the address that will sign', async () => {
    const caller = Keypair.random().publicKey();

    const args = await invokedArgs(caller);

    expect(Address.fromScVal(args[1]).toString()).toBe(caller);
  });
});
