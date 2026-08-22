import { Injectable, Logger } from '@nestjs/common';
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { Api, Server } from '@stellar/stellar-sdk/rpc';
import { AppConfigService } from '../config/app-config.service';
import { StellarReadService, withRpcTimeout } from './stellar-read.service';

const STELLAR_SECRET_RE = /^S[A-Z2-7]{55}$/;

@Injectable()
export class RefundSignerService {
  private readonly log = new Logger('RefundSigner');

  private keypairResolved = false;
  private cachedKeypair: Keypair | null = null;

  protected pollIntervalMs = 2000;
  protected pollTimeoutMs = 30_000;

  constructor(
    private cfg: AppConfigService,
    private stellarRead: StellarReadService,
  ) {}

  get isConfigured(): boolean {
    return this.resolveKeypair() !== null;
  }

  get publicKey(): string | null {
    return this.resolveKeypair()?.publicKey() ?? null;
  }

  private resolveKeypair(): Keypair | null {
    if (this.keypairResolved) return this.cachedKeypair;
    this.keypairResolved = true;

    const secret = this.cfg.refundSignerSecret;
    if (!secret) {
      this.cachedKeypair = null;
      return null;
    }
    if (!STELLAR_SECRET_RE.test(secret)) {
      this.log.warn(
        'REFUND_SIGNER_SECRET is set but is not a well-formed Stellar secret key (S...) — auto-refund cron will skip',
      );
      this.cachedKeypair = null;
      return null;
    }
    try {
      this.cachedKeypair = Keypair.fromSecret(secret);
    } catch {
      this.log.warn(
        'REFUND_SIGNER_SECRET failed checksum validation — auto-refund cron will skip',
      );
      this.cachedKeypair = null;
    }
    return this.cachedKeypair;
  }

  async submitRefund(
    contractId: string,
    tradeIdHex: string,
  ): Promise<{ status: string; hash: string }> {
    const kp = this.resolveKeypair();
    if (!kp) {
      throw new Error('RefundSignerService: signer not configured (REFUND_SIGNER_SECRET absent/invalid)');
    }
    const tx = await this.stellarRead.buildRefundTx(contractId, tradeIdHex, kp.publicKey());
    return this.signAndSubmit(tx, kp);
  }

  private async signAndSubmit(
    tx: Transaction,
    kp: Keypair,
  ): Promise<{ status: string; hash: string }> {
    this.assertIsSingleRefundOperation(tx);

    tx.sign(kp);
    const server = this.createRpcServer();

    let sendRes: Api.SendTransactionResponse;
    try {
      sendRes = await withRpcTimeout(server.sendTransaction(tx), 'sendTransaction');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`RefundSignerService: sendTransaction failed: ${msg}`);
    }

    const hash = sendRes.hash;
    this.log.log(`refund tx submitted (hash=${hash}, status=${sendRes.status})`);

    if (sendRes.status === 'ERROR') {
      throw new Error(`RefundSignerService: sendTransaction rejected (hash=${hash})`);
    }

    const finalStatus = await this.pollTransaction(server, hash);
    this.log.log(`refund tx finished (hash=${hash}, status=${finalStatus})`);
    return { status: finalStatus, hash };
  }

  private async pollTransaction(server: Server, hash: string): Promise<string> {
    const deadline = Date.now() + this.pollTimeoutMs;
    let usedTransientRetry = false;

    while (Date.now() < deadline) {
      let res: Api.GetTransactionResponse;
      try {
        res = await withRpcTimeout(server.getTransaction(hash), 'getTransaction');
      } catch (err) {
        if (!usedTransientRetry) {
          usedTransientRetry = true;
          await sleep(this.pollIntervalMs);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`RefundSignerService: getTransaction failed for hash=${hash}: ${msg}`);
      }

      if (res.status === Api.GetTransactionStatus.SUCCESS) return 'SUCCESS';
      if (res.status === Api.GetTransactionStatus.FAILED) return 'FAILED';

      await sleep(this.pollIntervalMs);
    }
    throw new Error(`RefundSignerService: getTransaction poll timed out for hash=${hash}`);
  }

  protected createRpcServer(): Server {
    return new Server(this.cfg.rpcUrl);
  }

  private assertIsSingleRefundOperation(tx: Transaction): void {
    if (tx.operations.length !== 1) {
      throw new Error(
        `RefundSignerService: refused to sign — expected exactly 1 operation, got ${tx.operations.length}`,
      );
    }
    const op = tx.operations[0];
    if (op.type !== 'invokeHostFunction') {
      throw new Error(
        `RefundSignerService: refused to sign — expected an invokeHostFunction operation, got "${op.type}"`,
      );
    }
    const hostFn = op.func;
    if (hostFn.type !== 'hostFunctionTypeInvokeContract') {
      throw new Error(
        'RefundSignerService: refused to sign — expected the host function to invoke a contract',
      );
    }
    const fnName = hostFn.invokeContract.functionName.toString();
    if (fnName !== 'refund') {
      throw new Error(
        `RefundSignerService: refused to sign — expected function "refund", got "${fnName}"`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
