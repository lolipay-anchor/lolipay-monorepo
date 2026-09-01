import { Account, Networks, StrKey, Transaction } from '@stellar/stellar-sdk';
import { PROBE_FUNCTION, buildProbeInvocation } from './signing-probe';

const ESCROW = StrKey.encodeContract(Buffer.alloc(32, 7));
const RPC = 'https://rpc.example';

function fakeServer(seen: { built?: Transaction; getAccountCalls: number }) {
  return () => ({
    getAccount: async (addr: string) => {
      seen.getAccountCalls += 1;
      return new Account(addr, '1');
    },
    prepareTransaction: async (tx: Transaction) => {
      seen.built = tx;
      return tx;
    },
  });
}

describe('the signing probe builds something a founder can sign without risk', () => {
  it('invokes a read on the escrow, never a function that can move money', async () => {
    const seen = { getAccountCalls: 0 } as { built?: Transaction; getAccountCalls: number };
    const who = 'GBCUZOOJ6W3BWPDW53QL3UDSXTGZNITUS32ZK7GE5ZQSLN7YUVOBHKJT';

    await buildProbeInvocation(RPC, Networks.TESTNET, ESCROW, who, fakeServer(seen));

    const op: any = seen.built!.operations[0];
    expect(op.type).toBe('invokeHostFunction');
    const call = op.func.invokeContract;
    expect(call.functionName.toString()).toBe(PROBE_FUNCTION);
    expect(call.functionName.toString()).toBe('get_config');
    expect(call.args.length).toBe(0);
    expect(seen.built!.source).toBe(who);
  });

  it('refuses a non-account address before it reaches the network at all', async () => {
    for (const bad of ['', 'not-an-address', 'GBAD', ESCROW]) {
      const seen = { getAccountCalls: 0 } as { built?: Transaction; getAccountCalls: number };
      await expect(
        buildProbeInvocation(RPC, Networks.TESTNET, ESCROW, bad, fakeServer(seen)),
      ).rejects.toThrow(/not a Stellar account address/);
      expect(seen.getAccountCalls).toBe(0);
    }
  });
});
