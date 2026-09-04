import { Keypair, Networks, TransactionBuilder, Account } from '@stellar/stellar-sdk';
import { signSendAndPoll } from './sign-send-poll';

function tx() {
  const kp = Keypair.random();
  const t = new TransactionBuilder(new Account(kp.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
    .setTimeout(300)
    .build();
  return { t, kp };
}

describe('a refused submission says why, so a closed window is not mistaken for a transient fault', () => {
  it('carries the network error result, and names the closed window for txTOO_LATE', async () => {
    const { t, kp } = tx();
    const server = { sendTransaction: jest.fn(async () => ({ status: 'ERROR', hash: 'h', errorResult: { result: () => ({ switch: () => ({ name: 'txTooLate' }) }) } })) } as any;
    const log = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
    await expect(signSendAndPoll(t, kp, { label: 'test', noun: 'test tx', server, log, networkPassphrase: Networks.TESTNET } as any)).rejects.toThrow(/txTooLate|too late|window .* closed/i);
  });
});
