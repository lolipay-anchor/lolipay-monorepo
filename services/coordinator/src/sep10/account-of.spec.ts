import { Account, Keypair, MuxedAccount } from '@stellar/stellar-sdk';
import { accountOf } from './account-signers.service';

const G = Keypair.random().publicKey();
const M = new MuxedAccount(new Account(G, '0'), '2').accountId();

describe('the Stellar account a SEP-10 subject belongs to', () => {
  it('leaves a bare account untouched', () => {
    expect(accountOf(G)).toBe(G);
  });

  it.each(['1', '2', '17509749319012223907'])('strips the memo %s a client chose', (memo) => {
    expect(accountOf(`${G}:${memo}`)).toBe(G);
  });

  it('collapses a muxed subject to the account that actually settles', () => {
    expect(M.startsWith('M')).toBe(true);
    expect(accountOf(M)).toBe(G);
  });

  it('returns something a Soroban Address can be built from, which is the whole point', () => {
    for (const subject of [G, `${G}:2`, M]) {
      expect(accountOf(subject)).toMatch(/^G[A-Z2-7]{55}$/);
    }
  });
});
