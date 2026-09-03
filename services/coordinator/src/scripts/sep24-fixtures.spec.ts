import { Account, Keypair, Networks, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { assembleSepConfig, sep53Signature, signSep10Challenge } from './sep24-fixtures';

const kp = Keypair.random();

describe('the SEP-24 fixture driver, its pure parts', () => {
  it('signs a SEP-53 nonce exactly the way the coordinator verifies it', () => {
    const nonce = 'abc123';
    const sig = sep53Signature(kp, nonce);
    const payload = Buffer.concat([
      Buffer.from('Stellar Signed Message:\n', 'utf8'),
      Buffer.from(nonce, 'utf8'),
    ]);
    expect(kp.verify(createHash('sha256').update(payload).digest(), Buffer.from(sig, 'base64'))).toBe(true);
  });

  it('adds only the client signature to a SEP-10 challenge and leaves the server signature intact', () => {
    const server = Keypair.random();
    const tx = new TransactionBuilder(new Account(server.publicKey(), '-1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.manageData({ name: 'lolipay.app auth', value: 'x'.repeat(48), source: kp.publicKey() }),
      )
      .setTimeout(300)
      .build();
    tx.sign(server);
    const back = new Transaction(
      signSep10Challenge(tx.toXdr(), kp, Networks.TESTNET),
      Networks.TESTNET,
    ) as any;
    expect(back.signatures).toHaveLength(2);
  });

  it('assembles a deposit-only config and places the secret exactly once', () => {
    const secret = Keypair.random().secret();
    const cfg = assembleSepConfig({
      secret,
      depositPending: { id: 'd1' },
      depositCompleted: { id: 'd2', stellar_transaction_id: 'h2' },
    });
    expect(cfg['24'].depositPendingTransaction).toEqual({ id: 'd1', status: 'pending_user_transfer_start' });
    expect(cfg['24'].depositCompletedTransaction).toEqual({
      id: 'd2',
      status: 'completed',
      stellar_transaction_id: 'h2',
    });
    expect(cfg['24']).not.toHaveProperty('withdrawPendingUserTransferStartTransaction');
    expect(cfg['24']).not.toHaveProperty('withdrawCompletedTransaction');
    expect(JSON.stringify(cfg).split(secret).length - 1).toBe(1);
  });
});
