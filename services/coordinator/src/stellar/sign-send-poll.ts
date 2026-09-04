import { Logger } from '@nestjs/common';
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { Api, Server } from '@stellar/stellar-sdk/rpc';
import { withRpcTimeout } from './stellar-read.service';

export interface SignSendPollOptions {
  label: string;
  noun: string;
  log: Logger;
  server: Server;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

export async function signSendAndPoll(
  tx: Transaction,
  kp: Keypair,
  opts: SignSendPollOptions,
): Promise<{ status: string; hash: string }> {
  tx.sign(kp);

  let sendRes: Api.SendTransactionResponse;
  try {
    sendRes = await withRpcTimeout(opts.server.sendTransaction(tx), 'sendTransaction');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${opts.label}: sendTransaction failed: ${msg}`);
  }

  const hash = sendRes.hash;
  opts.log.log(`${opts.noun} tx submitted (hash=${hash}, status=${sendRes.status})`);

  if (sendRes.status === 'ERROR') {
    const code = sendRes.errorResult?.result.type;
    const closed = code === 'txTooLate' ? '; the transaction window has closed' : '';
    throw new Error(`${opts.label}: sendTransaction rejected (hash=${hash}${code ? `, ${code}` : ''}${closed})`);
  }

  const finalStatus = await pollTransaction(opts, hash);
  opts.log.log(`${opts.noun} tx finished (hash=${hash}, status=${finalStatus})`);
  return { status: finalStatus, hash };
}

async function pollTransaction(opts: SignSendPollOptions, hash: string): Promise<string> {
  const deadline = Date.now() + opts.pollTimeoutMs;
  let usedTransientRetry = false;

  while (Date.now() < deadline) {
    let res: Api.GetTransactionResponse;
    try {
      res = await withRpcTimeout(opts.server.getTransaction(hash), 'getTransaction');
    } catch (err) {
      if (!usedTransientRetry) {
        usedTransientRetry = true;
        await sleep(opts.pollIntervalMs);
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${opts.label}: getTransaction failed for hash=${hash}: ${msg}`);
    }

    if (res.status === Api.GetTransactionStatus.SUCCESS) return 'SUCCESS';
    if (res.status === Api.GetTransactionStatus.FAILED) return 'FAILED';

    await sleep(opts.pollIntervalMs);
  }
  throw new Error(`${opts.label}: getTransaction poll timed out for hash=${hash}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
