import { Keypair, TransactionBuilder, Networks, Account, Operation, Address, xdr } from '@stellar/stellar-sdk';
import { assertIsThisTradesAttestation } from './attest-guard';

const CONTRACT = 'CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z';
const OTHER_CONTRACT = 'CAVJAMGCNBJQIDE6U7DHGYIWUREBOYH6PI2GWERLCF2DV6AGRAZOUBG2';
const TRADE = 'ab'.repeat(32);
const OTHER_TRADE = 'cd'.repeat(32);

function built(opts: { contractId?: string; fn?: string; tradeIdHex?: string; caller?: string; extraOp?: boolean } = {}) {
  const attestor = opts.caller ?? Keypair.random().publicKey();
  const src = new Account(Keypair.random().publicKey(), '1');
  const invoke = Operation.invokeContractFunction({
    contract: opts.contractId ?? CONTRACT,
    function: opts.fn ?? 'mark_fiat_paid',
    args: [
      xdr.ScVal.scvBytes(Buffer.from(opts.tradeIdHex ?? TRADE, 'hex')),
      new Address(attestor).toScVal(),
    ],
  });
  const b = new TransactionBuilder(src, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(invoke);
  if (opts.extraOp) b.addOperation(invoke);
  return { tx: b.setTimeout(30).build(), attestor };
}

describe('what the attestor is allowed to put its signature on', () => {
  it('accepts the one attestation it was asked to make', () => {
    const { tx, attestor } = built();
    expect(() =>
      assertIsThisTradesAttestation(tx, { contractId: CONTRACT, tradeIdHex: TRADE, attestor }),
    ).not.toThrow();
  });

  it('refuses a different escrow contract, so the key cannot be pointed at another deployment', () => {
    const { tx, attestor } = built();
    expect(() =>
      assertIsThisTradesAttestation(tx, { contractId: OTHER_CONTRACT, tradeIdHex: TRADE, attestor }),
    ).toThrow(/contract/i);
  });

  it('refuses a different trade, which is the whole capability being contained', () => {
    const { tx, attestor } = built({ tradeIdHex: OTHER_TRADE });
    expect(() =>
      assertIsThisTradesAttestation(tx, { contractId: CONTRACT, tradeIdHex: TRADE, attestor }),
    ).toThrow(/trade/i);
  });

  it('refuses any other contract function', () => {
    const { tx, attestor } = built({ fn: 'confirm_and_release' });
    expect(() =>
      assertIsThisTradesAttestation(tx, { contractId: CONTRACT, tradeIdHex: TRADE, attestor }),
    ).toThrow(/mark_fiat_paid/);
  });

  it('refuses a caller that is not the attestor whose key is about to sign', () => {
    const { tx } = built();
    expect(() =>
      assertIsThisTradesAttestation(tx, {
        contractId: CONTRACT,
        tradeIdHex: TRADE,
        attestor: Keypair.random().publicKey(),
      }),
    ).toThrow(/caller/i);
  });

  it('refuses a second operation smuggled into the same envelope', () => {
    const { tx, attestor } = built({ extraOp: true });
    expect(() =>
      assertIsThisTradesAttestation(tx, { contractId: CONTRACT, tradeIdHex: TRADE, attestor }),
    ).toThrow(/1 operation/);
  });
});
