import { Keypair, Networks, TransactionBuilder, Account, xdr } from '@stellar/stellar-sdk';
import { Server } from '@stellar/stellar-sdk/rpc';
import { Logger } from '@nestjs/common';
import { signSendAndPoll } from './sign-send-poll';

function tx() {
  const kp = Keypair.random();
  const t = new TransactionBuilder(new Account(kp.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .setTimeout(300)
    .build();
  return { t, kp };
}

function opts(sendTransaction: () => Promise<unknown>) {
  return {
    label: 'test',
    noun: 'test tx',
    log: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger,
    server: { sendTransaction } as unknown as Server,
    pollIntervalMs: 1,
    pollTimeoutMs: 10,
  };
}

describe('a refused submission says why, so a closed window is not mistaken for a transient fault', () => {
  it('carries the result code the network returned, decoded from the real XDR, and names the closed window for txTooLate', async () => {
    const { t, kp } = tx();
    const errorResult = xdr.TransactionResult.fromXdr('AAAAAAAAAGT////9AAAAAA==', 'base64');
    expect(errorResult.result.type).toBe('txTooLate');
    await expect(signSendAndPoll(t, kp, opts(async () => ({ status: 'ERROR', hash: 'h', errorResult })))).rejects.toThrow(
      /sendTransaction rejected \(hash=h, txTooLate; the transaction window has closed\)/,
    );
  });

  it('still names the rejection when the network sends no result body', async () => {
    const { t, kp } = tx();
    await expect(signSendAndPoll(t, kp, opts(async () => ({ status: 'ERROR', hash: 'h' })))).rejects.toThrow(/sendTransaction rejected \(hash=h\)$/);
  });
});
