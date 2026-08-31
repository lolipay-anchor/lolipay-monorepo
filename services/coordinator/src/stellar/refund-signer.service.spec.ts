import { Logger } from '@nestjs/common';
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { Api } from '@stellar/stellar-sdk/rpc';
import { MAX_REFUND_FEE_STROOPS, RefundSignerService } from './refund-signer.service';

function randomSecret(): { secret: string; publicKey: string } {
  const kp = Keypair.random();
  return { secret: kp.secret(), publicKey: kp.publicKey() };
}

const REFUND_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));

function buildRealRefundTx(sourcePublicKey: string, tradeIdHex = 'ab'.repeat(32)): Transaction {
  const account = new Account(sourcePublicKey, '1');
  const contractId = REFUND_CONTRACT_ID;
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'refund',
        args: [nativeToScVal(Buffer.from(tradeIdHex, 'hex'))],
      }),
    )
    .setTimeout(300)
    .build();
}

function makeSvc(refundSignerSecret?: string, stellarRead?: any) {
  const cfg = { refundSignerSecret, rpcUrl: 'https://rpc.example' } as any;
  return new RefundSignerService(cfg, stellarRead ?? { buildRefundTx: jest.fn() });
}

describe('RefundSignerService.isConfigured / publicKey', () => {
  it('is not configured when REFUND_SIGNER_SECRET is absent', () => {
    const svc = makeSvc(undefined);
    expect(svc.isConfigured).toBe(false);
    expect(svc.publicKey).toBeNull();
  });

  it('is not configured and warns ONCE when the secret is malformed (bad charset/length)', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const svc = makeSvc('not-a-real-secret');

    expect(svc.isConfigured).toBe(false);
    expect(svc.isConfigured).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).not.toContain('not-a-real-secret');
    warnSpy.mockRestore();
  });

  it('is not configured and warns when the secret has the right shape but a bad checksum', () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const badChecksum = 'S' + 'A'.repeat(55);
    const svc = makeSvc(badChecksum);

    expect(svc.isConfigured).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('is configured for a well-formed secret and exposes the matching public key', () => {
    const { secret, publicKey } = randomSecret();
    const svc = makeSvc(secret);

    expect(svc.isConfigured).toBe(true);
    expect(svc.publicKey).toBe(publicKey);
  });

  it('never logs the secret value across any Logger call', () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { secret } = randomSecret();
    const svc = makeSvc(secret);
    void svc.isConfigured;
    void svc.publicKey;

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(secret);
      }
    }
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('RefundSignerService.submitRefund', () => {
  it('throws without touching StellarReadService when the signer is not configured', async () => {
    const buildRefundTx = jest.fn();
    const svc = makeSvc(undefined, { buildRefundTx });

    await expect(svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32))).rejects.toThrow(/not configured/i);
    expect(buildRefundTx).not.toHaveBeenCalled();
  });

  it('builds the refund tx via StellarReadService.buildRefundTx using its OWN public key as source, then signs, submits, and polls until SUCCESS', async () => {
    const { secret, publicKey } = randomSecret();
    const tradeIdHex = 'cd'.repeat(32);
    const buildRefundTx = jest.fn(async (contractId: string, tid: string, sourceAddr: string) =>
      buildRealRefundTx(sourceAddr, tid),
    );
    const svc: any = makeSvc(secret, { buildRefundTx });
    svc.pollIntervalMs = 1;
    svc.pollTimeoutMs = 200;

    const sendTransaction = jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'deadbeef' });
    const getTransaction = jest
      .fn()
      .mockResolvedValueOnce({ status: Api.GetTransactionStatus.NOT_FOUND })
      .mockResolvedValueOnce({ status: Api.GetTransactionStatus.SUCCESS });
    svc.createRpcServer = () => ({ sendTransaction, getTransaction });

    const result = await svc.submitRefund(REFUND_CONTRACT_ID, tradeIdHex);

    expect(buildRefundTx).toHaveBeenCalledWith(REFUND_CONTRACT_ID, tradeIdHex, publicKey);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(getTransaction).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: 'SUCCESS', hash: 'deadbeef' });
  });

  it('propagates a FAILED terminal status without throwing', async () => {
    const { secret, publicKey } = randomSecret();
    const buildRefundTx = jest.fn(async () => buildRealRefundTx(publicKey));
    const svc: any = makeSvc(secret, { buildRefundTx });
    svc.pollIntervalMs = 1;
    svc.pollTimeoutMs = 200;

    const sendTransaction = jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'aa' });
    const getTransaction = jest.fn().mockResolvedValue({ status: Api.GetTransactionStatus.FAILED });
    svc.createRpcServer = () => ({ sendTransaction, getTransaction });

    const result = await svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32));
    expect(result).toEqual({ status: 'FAILED', hash: 'aa' });
  });

  it('throws immediately on sendTransaction ERROR status, never polling', async () => {
    const { secret, publicKey } = randomSecret();
    const buildRefundTx = jest.fn(async () => buildRealRefundTx(publicKey));
    const svc: any = makeSvc(secret, { buildRefundTx });

    const sendTransaction = jest.fn().mockResolvedValue({ status: 'ERROR', hash: 'bad' });
    const getTransaction = jest.fn();
    svc.createRpcServer = () => ({ sendTransaction, getTransaction });

    await expect(svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32))).rejects.toThrow(/rejected/i);
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it('retries ONE time on a transient getTransaction error, then succeeds', async () => {
    const { secret, publicKey } = randomSecret();
    const buildRefundTx = jest.fn(async () => buildRealRefundTx(publicKey));
    const svc: any = makeSvc(secret, { buildRefundTx });
    svc.pollIntervalMs = 1;
    svc.pollTimeoutMs = 500;

    const sendTransaction = jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'cc' });
    const getTransaction = jest
      .fn()
      .mockRejectedValueOnce(new Error('rpc hiccup'))
      .mockResolvedValueOnce({ status: Api.GetTransactionStatus.SUCCESS });
    svc.createRpcServer = () => ({ sendTransaction, getTransaction });

    const result = await svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32));
    expect(result.status).toBe('SUCCESS');
    expect(getTransaction).toHaveBeenCalledTimes(2);
  });

  it('gives up after a SECOND consecutive transient getTransaction error', async () => {
    const { secret, publicKey } = randomSecret();
    const buildRefundTx = jest.fn(async () => buildRealRefundTx(publicKey));
    const svc: any = makeSvc(secret, { buildRefundTx });
    svc.pollIntervalMs = 1;
    svc.pollTimeoutMs = 500;

    const sendTransaction = jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'dd' });
    const getTransaction = jest.fn().mockRejectedValue(new Error('rpc down'));
    svc.createRpcServer = () => ({ sendTransaction, getTransaction });

    await expect(svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32))).rejects.toThrow(/rpc down/);
    expect(getTransaction).toHaveBeenCalledTimes(2);
  });

  it('times out if the tx never lands (stays NOT_FOUND for the whole budget)', async () => {
    const { secret, publicKey } = randomSecret();
    const buildRefundTx = jest.fn(async () => buildRealRefundTx(publicKey));
    const svc: any = makeSvc(secret, { buildRefundTx });
    svc.pollIntervalMs = 5;
    svc.pollTimeoutMs = 20;

    const sendTransaction = jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'ee' });
    const getTransaction = jest.fn().mockResolvedValue({ status: Api.GetTransactionStatus.NOT_FOUND });
    svc.createRpcServer = () => ({ sendTransaction, getTransaction });

    await expect(svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32))).rejects.toThrow(/timed out/i);
  });

  it('never logs the secret or the fully-signed XDR — only hash/status', async () => {
    const { secret, publicKey } = randomSecret();
    let builtTx: Transaction;
    const buildRefundTx = jest.fn(async () => {
      builtTx = buildRealRefundTx(publicKey);
      return builtTx;
    });
    const svc: any = makeSvc(secret, { buildRefundTx });
    svc.pollIntervalMs = 1;
    svc.pollTimeoutMs = 200;

    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const sendTransaction = jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'ff' });
    const getTransaction = jest.fn().mockResolvedValue({ status: Api.GetTransactionStatus.SUCCESS });
    svc.createRpcServer = () => ({ sendTransaction, getTransaction });

    await svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32));

    const signedXdr = builtTx!.toXdr();
    for (const call of logSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(secret);
        expect(String(arg)).not.toContain(signedXdr);
      }
    }
    logSpy.mockRestore();
  });

  describe('the structural refund-only assertion', () => {
    it('refuses a refund pointed at a contract other than the one asked for', async () => {
      const { secret, publicKey } = randomSecret();
      const elsewhere = StrKey.encodeContract(Buffer.alloc(32, 9));
      const account = new Account(publicKey, '1');
      const doctoredTx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: elsewhere,
            function: 'refund',
            args: [nativeToScVal(Buffer.from('ab'.repeat(32), 'hex'))],
          }),
        )
        .setTimeout(300)
        .build();
      const svc: any = makeSvc(secret, { buildRefundTx: jest.fn(async () => doctoredTx) });
      const sendTransaction = jest.fn();
      svc.createRpcServer = () => ({ sendTransaction, getTransaction: jest.fn() });

      await expect(svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32))).rejects.toThrow(
        /refused to sign — expected contract/,
      );
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('refuses a refund that names a different trade than the one asked for', async () => {
      const { secret, publicKey } = randomSecret();
      const svc: any = makeSvc(secret, {
        buildRefundTx: jest.fn(async () => buildRealRefundTx(publicKey, 'cd'.repeat(32))),
      });
      const sendTransaction = jest.fn();
      svc.createRpcServer = () => ({ sendTransaction, getTransaction: jest.fn() });

      await expect(svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32))).rejects.toThrow(
        /refused to sign — expected trade/,
      );
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('refuses a fee the account would not knowingly pay, however well-shaped the call', async () => {
      const { secret, publicKey } = randomSecret();
      const account = new Account(publicKey, '1');
      const doctoredTx = new TransactionBuilder(account, {
        fee: String(MAX_REFUND_FEE_STROOPS + 1),
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: REFUND_CONTRACT_ID,
            function: 'refund',
            args: [nativeToScVal(Buffer.from('ab'.repeat(32), 'hex'))],
          }),
        )
        .setTimeout(300)
        .build();
      const svc: any = makeSvc(secret, { buildRefundTx: jest.fn(async () => doctoredTx) });
      const sendTransaction = jest.fn();
      svc.createRpcServer = () => ({ sendTransaction, getTransaction: jest.fn() });

      await expect(svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32))).rejects.toThrow(
        /refused to sign — expected a fee at or under/,
      );
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('refuses to sign a tx with more than one operation', async () => {
      const { secret, publicKey } = randomSecret();
      const account = new Account(publicKey, '1');
      const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
      const doctoredTx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: contractId,
            function: 'refund',
            args: [nativeToScVal(Buffer.from('ab'.repeat(32), 'hex'))],
          }),
        )
        .addOperation(
          Operation.invokeContractFunction({
            contract: contractId,
            function: 'refund',
            args: [nativeToScVal(Buffer.from('cd'.repeat(32), 'hex'))],
          }),
        )
        .setTimeout(300)
        .build();

      const buildRefundTx = jest.fn().mockResolvedValue(doctoredTx);
      const svc: any = makeSvc(secret, { buildRefundTx });
      const sendTransaction = jest.fn();
      svc.createRpcServer = () => ({ sendTransaction, getTransaction: jest.fn() });

      await expect(svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32))).rejects.toThrow(
        /expected exactly 1 operation/i,
      );
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('refuses to sign a well-shaped invokeContractFunction op targeting a DIFFERENT function', async () => {
      const { secret, publicKey } = randomSecret();
      const account = new Account(publicKey, '1');
      const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
      const doctoredTx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: contractId,
            function: 'confirm_and_release',
            args: [nativeToScVal(Buffer.from('ab'.repeat(32), 'hex'))],
          }),
        )
        .setTimeout(300)
        .build();

      const buildRefundTx = jest.fn().mockResolvedValue(doctoredTx);
      const svc: any = makeSvc(secret, { buildRefundTx });
      const sendTransaction = jest.fn();
      svc.createRpcServer = () => ({ sendTransaction, getTransaction: jest.fn() });

      await expect(svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32))).rejects.toThrow(
        /expected function "refund"/i,
      );
      expect(sendTransaction).not.toHaveBeenCalled();
    });

    it('accepts the real shape buildRefundTx produces (control case for the two tests above)', async () => {
      const { secret, publicKey } = randomSecret();
      const buildRefundTx = jest.fn().mockResolvedValue(buildRealRefundTx(publicKey));
      const svc: any = makeSvc(secret, { buildRefundTx });
      svc.pollIntervalMs = 1;
      svc.pollTimeoutMs = 200;

      const sendTransaction = jest.fn().mockResolvedValue({ status: 'PENDING', hash: 'gg' });
      const getTransaction = jest.fn().mockResolvedValue({ status: Api.GetTransactionStatus.SUCCESS });
      svc.createRpcServer = () => ({ sendTransaction, getTransaction });

      const result = await svc.submitRefund(REFUND_CONTRACT_ID, 'ab'.repeat(32));
      expect(result.status).toBe('SUCCESS');
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    });
  });
});
