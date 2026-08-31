import { Keypair, TransactionBuilder, Networks, Account, Operation, Address, xdr } from '@stellar/stellar-sdk';
import { MAX_ATTEST_FEE_STROOPS } from './attest-guard';
import { assertIsThisTradesAttestation } from './attest-guard';

const CONTRACT = 'CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z';
const OTHER_CONTRACT = 'CAVJAMGCNBJQIDE6U7DHGYIWUREBOYH6PI2GWERLCF2DV6AGRAZOUBG2';
const TRADE = 'ab'.repeat(32);
const OTHER_TRADE = 'cd'.repeat(32);

function built(opts: { contractId?: string; fn?: string; tradeIdHex?: string; caller?: string; extraOp?: boolean; fee?: number } = {}) {
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
  const b = new TransactionBuilder(src, { fee: String(opts.fee ?? 100), networkPassphrase: Networks.TESTNET })
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

describe('what the attestor will not put its signature near', () => {
  const REAL_TESTNET_AUTH =
    'AAAAAAAAAAAAAAAB1J66+rY5rg7vZiJkamJk0dWUy5LPIKgdA4aDTlyOpoEAAAAObWFya19maWF0X3BhaWQAAAAAAAIAAAANAAAAID5Xti0/fMHLzSViRGiYT83tsfTxaCcMADPAhIZPUhduAAAAEgAAAAAAAAAA9XD6G5QwaYqPB22+/PxrVQ0XlzTQsbPESfRd/xBy3PkAAAAA';
  const REAL_TESTNET_TRADE = '3e57b62d3f7cc1cbcd25624468984fcdedb1f4f168270c0033c084864f52176e';
  const REAL_TESTNET_ATTESTOR = 'GD2XB6Q3SQYGTCUPA5W357H4NNKQ2F4XGTILDM6EJH2F37YQOLOPTPP2';

  it('accepts the authorisation entry a real testnet preparation actually returns', () => {
    const { tx } = built({ tradeIdHex: REAL_TESTNET_TRADE, caller: REAL_TESTNET_ATTESTOR });
    (tx.operations[0] as any).auth = [
      xdr.SorobanAuthorizationEntry.fromXdr(Buffer.from(REAL_TESTNET_AUTH, 'base64')),
    ];

    expect(() =>
      assertIsThisTradesAttestation(tx, {
        contractId: CONTRACT,
        tradeIdHex: REAL_TESTNET_TRADE,
        attestor: REAL_TESTNET_ATTESTOR,
      }),
    ).not.toThrow();
  });

  it('refuses an authorisation entry that is not the one this call implies', () => {
    const { tx, attestor } = built();
    (tx.operations[0] as any).auth = [
      xdr.SorobanAuthorizationEntry.fromXdr(Buffer.from(REAL_TESTNET_AUTH, 'base64')),
    ];

    expect(() =>
      assertIsThisTradesAttestation(tx, { contractId: CONTRACT, tradeIdHex: TRADE, attestor }),
    ).toThrow(/authorisation entry/i);
  });

  it('refuses the sub-invocation attack: a correct call whose authorisation smuggles a transfer', () => {
    const { tx, attestor } = built();
    const call = new xdr.InvokeContractArgs({
      contractAddress: new Address(CONTRACT).toScAddress(),
      functionName: 'mark_fiat_paid',
      args: [xdr.ScVal.scvBytes(Buffer.from(TRADE, 'hex')), new Address(attestor).toScVal()],
    });
    (tx.operations[0] as any).auth = [
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
          subInvocations: [
            new xdr.SorobanAuthorizedInvocation({
              function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                new xdr.InvokeContractArgs({
                  contractAddress: new Address(OTHER_CONTRACT).toScAddress(),
                  functionName: 'transfer',
                  args: [],
                }),
              ),
              subInvocations: [],
            }),
          ],
        }),
      }),
    ];

    expect(() =>
      assertIsThisTradesAttestation(tx, { contractId: CONTRACT, tradeIdHex: TRADE, attestor }),
    ).toThrow(/authorisation entry/i);
  });

  it('refuses more than one authorisation entry', () => {
    const { tx, attestor } = built();
    const entry = xdr.SorobanAuthorizationEntry.fromXdr(Buffer.from(REAL_TESTNET_AUTH, 'base64'));
    (tx.operations[0] as any).auth = [entry, entry];

    expect(() =>
      assertIsThisTradesAttestation(tx, { contractId: CONTRACT, tradeIdHex: TRADE, attestor }),
    ).toThrow(/at most 1 authorisation/i);
  });

  it('refuses a fee a hostile rpc inflated, because the attestor pays it', () => {
    const { tx, attestor } = built({ fee: MAX_ATTEST_FEE_STROOPS + 1 });

    expect(() =>
      assertIsThisTradesAttestation(tx, { contractId: CONTRACT, tradeIdHex: TRADE, attestor }),
    ).toThrow(/fee/i);
  });

  it('still accepts the fee a normal preparation produces', () => {
    const { tx, attestor } = built({ fee: MAX_ATTEST_FEE_STROOPS });

    expect(() =>
      assertIsThisTradesAttestation(tx, { contractId: CONTRACT, tradeIdHex: TRADE, attestor }),
    ).not.toThrow();
  });
});
