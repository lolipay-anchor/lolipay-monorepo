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
import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
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
    await expect(svc.attest(CONTRACT, TRADE, Math.floor(Date.now() / 1000) + 3600)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(svc.attest(CONTRACT, TRADE, Math.floor(Date.now() / 1000) + 3600)).rejects.toThrow(/attestor key is configured/i);
    expect(built).not.toHaveBeenCalled();
  });

  it('refuses a key the chain does not name as attestor, and never builds a transaction', async () => {
    const kp = Keypair.random();
    const { svc, built } = makeSvc(kp.secret(), Keypair.random().publicKey());

    await expect(svc.attest(CONTRACT, TRADE, Math.floor(Date.now() / 1000) + 3600)).rejects.toThrow(/is not the attestor/i);

    expect(built).not.toHaveBeenCalled();
  });

  it('names the immutability in the refusal, because a wrong key cannot be fixed by config', async () => {
    const kp = Keypair.random();
    const { svc } = makeSvc(kp.secret(), Keypair.random().publicKey());
    await expect(svc.attest(CONTRACT, TRADE, Math.floor(Date.now() / 1000) + 3600)).rejects.toThrow(/immutable/i);
  });

  it('refuses a contract this anchor does not recognise, before it asks that contract anything', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());

    await expect(
      svc.attest('CAVJAMGCNBJQIDE6U7DHGYIWUREBOYH6PI2GWERLCF2DV6AGRAZOUBG2', TRADE, Math.floor(Date.now() / 1000) + 3600),
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

    await expect(svc.attest(older, TRADE, Math.floor(Date.now() / 1000) + 3600)).rejects.toThrow('stop here');
  });

  it('asks the chain once per contract, not once per attestation', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    read.buildMarkFiatPaidTx.mockRejectedValue(new Error('stop here'));

    await expect(svc.attest(CONTRACT, TRADE, Math.floor(Date.now() / 1000) + 3600)).rejects.toThrow('stop here');
    await expect(svc.attest(CONTRACT, TRADE, Math.floor(Date.now() / 1000) + 3600)).rejects.toThrow('stop here');

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

    await expect(svc.attest(CONTRACT, TRADE, Math.floor(Date.now() / 1000) + 3600)).rejects.toThrow(/refused to sign/i);
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

    await expect(svc.attest(CONTRACT, TRADE, Math.floor(Date.now() / 1000) + 3600)).rejects.toThrow(/refused to sign/i);
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

    await expect(svc.attest(CONTRACT, TRADE, Math.floor(Date.now() / 1000) + 3600)).resolves.toEqual({
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
      await svc.attest(CONTRACT, TRADE, Math.floor(Date.now() / 1000) + 3600);

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

    await expect(svc.attest(CONTRACT, TRADE, Math.floor(Date.now() / 1000) + 3600)).rejects.toThrow('stop here');

    expect(read.buildMarkFiatPaidTx).toHaveBeenCalledWith(CONTRACT, kp.publicKey(), TRADE, expect.any(Number));
  });

  function heldAtFirstPoll() {
    let reachedPoll!: () => void;
    const firstPolled = new Promise<void>((resolve) => (reachedPoll = resolve));
    let settleFirst!: () => void;
    const held = new Promise<{ status: Api.GetTransactionStatus }>(
      (resolve) => (settleFirst = () => resolve({ status: Api.GetTransactionStatus.SUCCESS })),
    );
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ status: 'PENDING', hash: 'first' })
      .mockResolvedValueOnce({ status: 'PENDING', hash: 'second' });
    const getTransaction = jest
      .fn()
      .mockImplementationOnce(() => {
        reachedPoll();
        return held;
      })
      .mockResolvedValue({ status: Api.GetTransactionStatus.SUCCESS });
    return { server: { sendTransaction, getTransaction }, firstPolled, settleFirst, sendTransaction };
  }

  function readyToSubmit(kp: Keypair, server: unknown) {
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    read.buildMarkFiatPaidTx.mockResolvedValue(envelopeFor({ caller: kp.publicKey(), withAuth: true }));
    (svc as any).pollIntervalMs = 1;
    (svc as any).pollTimeoutMs = 200;
    (svc as any).createRpcServer = () => server;
    return { svc, read };
  }

  it('builds the next attestation only after the previous one has settled on chain, so two never load the same sequence number', async () => {
    const kp = Keypair.random();
    const { server, firstPolled, settleFirst } = heldAtFirstPoll();
    const { svc, read } = readyToSubmit(kp, server);
    const notAfter = Math.floor(Date.now() / 1000) + 3600;

    const first = svc.attest(CONTRACT, TRADE, notAfter);
    const second = svc.attest(CONTRACT, TRADE, notAfter);
    await firstPolled;
    await new Promise((resolve) => setImmediate(resolve));

    expect(read.buildMarkFiatPaidTx).toHaveBeenCalledTimes(1);

    settleFirst();
    await expect(first).resolves.toEqual({ status: 'SUCCESS', hash: 'first' });
    await expect(second).resolves.toEqual({ status: 'SUCCESS', hash: 'second' });
    expect(read.buildMarkFiatPaidTx).toHaveBeenCalledTimes(2);
  });

  it('runs the next attestation after the previous one was refused, so one failure cannot wedge the key', async () => {
    const kp = Keypair.random();
    const { svc, read } = readyToSubmit(kp, {
      sendTransaction: jest.fn(async () => ({ status: 'PENDING', hash: 'second' })),
      getTransaction: jest.fn(async () => ({ status: Api.GetTransactionStatus.SUCCESS })),
    });
    read.buildMarkFiatPaidTx.mockRejectedValueOnce(new Error('first build failed'));
    const notAfter = Math.floor(Date.now() / 1000) + 3600;

    const first = svc.attest(CONTRACT, TRADE, notAfter);
    const second = svc.attest(CONTRACT, TRADE, notAfter);

    await expect(first).rejects.toThrow('first build failed');
    await expect(second).resolves.toEqual({ status: 'SUCCESS', hash: 'second' });
  });

  it('refuses without building or sending when its deadline passes while it waits for the key, so a queued confirmation never becomes a late transaction', async () => {
    const kp = Keypair.random();
    const { server, firstPolled, settleFirst, sendTransaction } = heldAtFirstPoll();
    const { svc, read } = readyToSubmit(kp, server);
    const deadline = 2_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(deadline * 1000);

    try {
      const first = svc.attest(CONTRACT, TRADE, deadline + 3600);
      const second = svc.attest(CONTRACT, TRADE, deadline);
      await firstPolled;

      clock.mockReturnValue((deadline + 1) * 1000);
      settleFirst();

      await expect(first).resolves.toEqual({ status: 'SUCCESS', hash: 'first' });
      await expect(second).rejects.toBeInstanceOf(ConflictException);
      await expect(second).rejects.toThrow(
        'The time to confirm this payment has passed, so it can no longer be confirmed, and nothing was sent to the network.',
      );
      expect(read.buildMarkFiatPaidTx).toHaveBeenCalledTimes(1);
      expect(read.buildMarkFiatPaidTx).not.toHaveBeenCalledWith(CONTRACT, kp.publicKey(), TRADE, deadline);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('still attests within the deadline second itself, because the contract admits the deadline and no margin is taken', async () => {
    const kp = Keypair.random();
    const { svc, read } = readyToSubmit(kp, {
      sendTransaction: jest.fn(async () => ({ status: 'PENDING', hash: 'edge' })),
      getTransaction: jest.fn(async () => ({ status: Api.GetTransactionStatus.SUCCESS })),
    });
    const deadline = 2_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(deadline * 1000 + 999);

    try {
      await expect(svc.attest(CONTRACT, TRADE, deadline)).resolves.toEqual({ status: 'SUCCESS', hash: 'edge' });
      expect(read.buildMarkFiatPaidTx).toHaveBeenCalledWith(CONTRACT, kp.publicKey(), TRADE, deadline);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('the attestor reports the balance of the account that pays for its confirmations', () => {
  afterEach(() => jest.useRealTimers());

  function ledgerEntryFor(kp: Keypair, balance: bigint) {
    return {
      key: xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: kp.xdrPublicKey() })),
      val: xdr.LedgerEntryData.account(
        new xdr.AccountEntry({
          accountId: kp.xdrPublicKey(),
          balance,
          seqNum: 1n,
          numSubEntries: 0,
          inflationDest: null,
          flags: 0,
          homeDomain: '',
          thresholds: Buffer.from([1, 0, 0, 0]),
          signers: [],
          ext: xdr.AccountEntryExt.v0(),
        }),
      ),
    };
  }

  function serviceReading(kp: Keypair, getLedgerEntries: jest.Mock) {
    const { svc } = makeSvc(kp.secret());
    (svc as any).createRpcServer = () => ({ getLedgerEntries });
    return svc;
  }

  it('returns the native balance in stroops as an exact integer, read with the ledger key of its own account', async () => {
    const kp = Keypair.random();
    const getLedgerEntries = jest.fn(async (..._keys: unknown[]) => ({
      entries: [ledgerEntryFor(kp, 123_456_789n)],
      latestLedger: 1,
    }));

    await expect(serviceReading(kp, getLedgerEntries).nativeBalanceStroops()).resolves.toBe(123_456_789n);

    const ownKey = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: kp.xdrPublicKey() }));
    expect(getLedgerEntries).toHaveBeenCalledTimes(1);
    expect((getLedgerEntries.mock.calls[0] as any[])[0].toXdr('base64')).toBe(ownKey.toXdr('base64'));
  });

  it('keeps every stroop of a balance above the safe integer range, because money is never a float', async () => {
    const kp = Keypair.random();
    const huge = 9_007_199_254_740_993n;
    const getLedgerEntries = jest.fn(async () => ({ entries: [ledgerEntryFor(kp, huge)], latestLedger: 1 }));

    await expect(serviceReading(kp, getLedgerEntries).nativeBalanceStroops()).resolves.toBe(huge);
  });

  it('returns zero when the ledger holds no such account, because an account that does not exist holds no lumens and the empty answer is not a failure', async () => {
    const kp = Keypair.random();
    const getLedgerEntries = jest.fn(async () => ({ entries: [], latestLedger: 1 }));

    await expect(serviceReading(kp, getLedgerEntries).nativeBalanceStroops()).resolves.toBe(0n);
  });

  it('throws when the read fails, rather than answering with a number it does not know', async () => {
    const kp = Keypair.random();
    const getLedgerEntries = jest.fn().mockRejectedValue(new Error('the rpc said no'));

    await expect(serviceReading(kp, getLedgerEntries).nativeBalanceStroops()).rejects.toThrow('the rpc said no');
    expect(getLedgerEntries).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure once, as every other read this service depends on does', async () => {
    const kp = Keypair.random();
    const getLedgerEntries = jest
      .fn()
      .mockRejectedValueOnce(new Error('network unreachable'))
      .mockResolvedValueOnce({ entries: [ledgerEntryFor(kp, 42n)], latestLedger: 1 });

    await expect(serviceReading(kp, getLedgerEntries).nativeBalanceStroops()).resolves.toBe(42n);
    expect(getLedgerEntries).toHaveBeenCalledTimes(2);
  });

  it('gives up on an rpc that never answers, so one stalled call cannot hold a monitoring tick open', async () => {
    jest.useFakeTimers();
    const kp = Keypair.random();
    const getLedgerEntries = jest.fn(() => new Promise<never>(() => undefined));
    const pending = serviceReading(kp, getLedgerEntries).nativeBalanceStroops();
    const settled = expect(pending).rejects.toThrow(/timed out/);

    await jest.advanceTimersByTimeAsync(60_000);

    await settled;
  });

  it('refuses to read a ledger entry that is not an account as a balance', async () => {
    const kp = Keypair.random();
    const getLedgerEntries = jest.fn(async () => ({
      entries: [{ key: {}, val: { type: 'ttl', value: { balance: 1n } } }],
      latestLedger: 1,
    }));

    await expect(serviceReading(kp, getLedgerEntries).nativeBalanceStroops()).rejects.toThrow(/ttl/);
  });

  it('returns null and asks the network nothing when no key is configured', async () => {
    const { svc } = makeSvc(undefined);
    const createRpcServer = jest.fn();
    (svc as any).createRpcServer = createRpcServer;

    await expect(svc.nativeBalanceStroops()).resolves.toBeNull();
    expect(createRpcServer).not.toHaveBeenCalled();
  });
});
