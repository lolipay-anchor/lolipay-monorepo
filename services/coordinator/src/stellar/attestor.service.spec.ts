import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { Api } from '@stellar/stellar-sdk/rpc';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { AttestorService } from './attestor.service';

const CONTRACT = 'CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z';
const TRADE = 'ab'.repeat(32);

function makeSvc(secret: string | undefined, onChainAttestor?: string) {
  const cfg = {
    attestorSecret: secret,
    rpcUrl: 'https://example.invalid',
    escrowContractId: CONTRACT,
    escrowContractIdsExtra: [] as string[],
  } as any;
  const built = jest.fn();
  const read = {
    readEscrowFiatAttestor: jest.fn(async () => onChainAttestor ?? 'GUNSET'),
    buildMarkFiatPaidTx: built,
  } as any;
  return { svc: new AttestorService(cfg, read), read, built };
}

describe('the attestor refuses before it signs, not after', () => {
  it('is not configured when the secret is absent', () => {
    expect(makeSvc(undefined).svc.isConfigured).toBe(false);
  });

  it('is not configured when the secret is malformed, and says so rather than throwing at boot', () => {
    expect(makeSvc('not-a-stellar-secret').svc.isConfigured).toBe(false);
  });

  it('refuses to attest at all when unconfigured, as unavailable rather than broken', async () => {
    const { svc, built } = makeSvc(undefined);
    await expect(svc.attest(CONTRACT, TRADE)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow(/attestor key is configured/i);
    expect(built).not.toHaveBeenCalled();
  });

  it('refuses a key the chain does not name as attestor, and never builds a transaction', async () => {
    const kp = Keypair.random();
    const { svc, built } = makeSvc(kp.secret(), Keypair.random().publicKey());

    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow(/is not the attestor/i);

    expect(built).not.toHaveBeenCalled();
  });

  it('names the immutability in the refusal, because a wrong key cannot be fixed by config', async () => {
    const kp = Keypair.random();
    const { svc } = makeSvc(kp.secret(), Keypair.random().publicKey());
    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow(/immutable/i);
  });

  it('refuses a contract this anchor does not recognise, before it asks that contract anything', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());

    await expect(
      svc.attest('CAVJAMGCNBJQIDE6U7DHGYIWUREBOYH6PI2GWERLCF2DV6AGRAZOUBG2', TRADE),
    ).rejects.toThrow(/not an escrow this anchor/i);

    expect(read.readEscrowFiatAttestor).not.toHaveBeenCalled();
    expect(read.buildMarkFiatPaidTx).not.toHaveBeenCalled();
  });

  it('accepts a pre-cutover escrow that is still on the allowlist', async () => {
    const kp = Keypair.random();
    const older = 'CAVJAMGCNBJQIDE6U7DHGYIWUREBOYH6PI2GWERLCF2DV6AGRAZOUBG2';
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    (svc as any).cfg.escrowContractIdsExtra = [older];
    read.buildMarkFiatPaidTx.mockRejectedValue(new Error('stop here'));

    await expect(svc.attest(older, TRADE)).rejects.toThrow('stop here');
  });

  it('asks the chain once per contract, not once per attestation', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    read.buildMarkFiatPaidTx.mockRejectedValue(new Error('stop here'));

    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow('stop here');
    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow('stop here');

    expect(read.readEscrowFiatAttestor).toHaveBeenCalledTimes(1);
  });

  function envelopeFor(opts: {
    contractId?: string;
    tradeIdHex?: string;
    caller: string;
    withAuth?: boolean;
  }) {
    const contract = opts.contractId ?? CONTRACT;
    const args = [
      xdr.ScVal.scvBytes(Buffer.from(opts.tradeIdHex ?? TRADE, 'hex')),
      new Address(opts.caller).toScVal(),
    ];
    const invocation = new xdr.InvokeContractArgs({
      contractAddress: new Address(contract).toScAddress(),
      functionName: 'mark_fiat_paid',
      args,
    });
    const src = new Account(Keypair.random().publicKey(), '1');
    const tx = new TransactionBuilder(src, { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(
        Operation.invokeContractFunction({
          contract,
          function: 'mark_fiat_paid',
          args,
          auth: opts.withAuth
            ? [
                new xdr.SorobanAuthorizationEntry({
                  credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
                  rootInvocation: new xdr.SorobanAuthorizedInvocation({
                    function:
                      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                        invocation,
                      ),
                    subInvocations: [],
                  }),
                }),
              ]
            : undefined,
        }),
      )
      .setTimeout(30)
      .build();
    return { xdr: tx.toXdr(), networkPassphrase: Networks.TESTNET };
  }

  it('refuses to sign an envelope naming a different trade than the one it was asked to attest', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    read.buildMarkFiatPaidTx.mockResolvedValue(
      envelopeFor({ tradeIdHex: 'cd'.repeat(32), caller: kp.publicKey() }),
    );

    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow(/refused to sign/i);
  });

  it('refuses to sign an envelope pointed at a different escrow contract', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    read.buildMarkFiatPaidTx.mockResolvedValue(
      envelopeFor({
        contractId: 'CAVJAMGCNBJQIDE6U7DHGYIWUREBOYH6PI2GWERLCF2DV6AGRAZOUBG2',
        caller: kp.publicKey(),
      }),
    );

    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow(/refused to sign/i);
  });

  it('signs with its own key and submits, and reports what the chain said', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    read.buildMarkFiatPaidTx.mockResolvedValue(
      envelopeFor({ caller: kp.publicKey(), withAuth: true }),
    );

    let submitted: Transaction | undefined;
    const sendTransaction = jest.fn(async (tx: Transaction) => {
      submitted = tx;
      return { status: 'PENDING', hash: 'facade' };
    });
    const getTransaction = jest.fn(async () => ({ status: Api.GetTransactionStatus.SUCCESS }));
    (svc as any).pollIntervalMs = 1;
    (svc as any).pollTimeoutMs = 200;
    (svc as any).createRpcServer = () => ({ sendTransaction, getTransaction });

    await expect(svc.attest(CONTRACT, TRADE)).resolves.toEqual({
      status: 'SUCCESS',
      hash: 'facade',
    });

    expect(submitted).toBeDefined();
    expect(submitted!.signatures).toHaveLength(1);
    expect(kp.verify(submitted!.hash(), submitted!.signatures[0].signature)).toBe(true);

    const op: any = submitted!.operations[0];
    expect(op.auth).toHaveLength(1);
    const args = op.func.invokeContract.args;
    expect(Buffer.from(scValToNative(args[0]) as Uint8Array).toString('hex')).toBe(TRADE);
    expect(Address.fromScVal(args[1]).toString()).toBe(kp.publicKey());
  });

  it('never logs its secret or the signed envelope, only the hash and the status', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    read.buildMarkFiatPaidTx.mockResolvedValue(envelopeFor({ caller: kp.publicKey() }));

    let submitted: Transaction | undefined;
    const sendTransaction = jest.fn(async (tx: Transaction) => {
      submitted = tx;
      return { status: 'PENDING', hash: 'facade' };
    });
    (svc as any).pollIntervalMs = 1;
    (svc as any).pollTimeoutMs = 200;
    (svc as any).createRpcServer = () => ({
      sendTransaction,
      getTransaction: jest.fn(async () => ({ status: Api.GetTransactionStatus.SUCCESS })),
    });

    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      await svc.attest(CONTRACT, TRADE);

      const signedXdr = submitted!.toXdr();
      for (const call of [...logSpy.mock.calls, ...warnSpy.mock.calls]) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(kp.secret());
          expect(String(arg)).not.toContain(signedXdr);
        }
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('builds against the contract and trade it was given, signing as itself', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    read.buildMarkFiatPaidTx.mockRejectedValue(new Error('stop here'));

    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow('stop here');

    expect(read.buildMarkFiatPaidTx).toHaveBeenCalledWith(CONTRACT, kp.publicKey(), TRADE);
  });
});
