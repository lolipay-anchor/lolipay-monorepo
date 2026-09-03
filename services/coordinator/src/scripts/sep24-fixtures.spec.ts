import { Account, Address, Asset, Contract, Keypair, Networks, Operation, Transaction, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { MAX_ATTEST_FEE_STROOPS } from '../stellar/attest-guard';
import {
  TESTNET_PASSPHRASE,
  assembleSepConfig,
  assertEscrowCall,
  assertTestnet,
  pickFreshOrder,
  readChallenge,
  sep53Signature,
  signSep10Challenge,
} from './sep24-fixtures';

const kp = Keypair.random();
const ESCROW = 'CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z';
const HOME = 'lolipay.app';
const WEB_AUTH = 'api.lolipay.app';

function challengeFrom(server: Keypair, client: string, passphrase = Networks.TESTNET): string {
  const tx = new TransactionBuilder(new Account(server.publicKey(), '-1'), { fee: '100', networkPassphrase: passphrase })
    .addOperation(Operation.manageData({ name: `${HOME} auth`, value: Buffer.from('x'.repeat(48)).toString('base64').slice(0, 64), source: client }))
    .addOperation(Operation.manageData({ name: 'web_auth_domain', value: WEB_AUTH, source: server.publicKey() }))
    .setTimeout(300)
    .build();
  tx.sign(server);
  return tx.toXdr();
}

const TRADE = 'ab'.repeat(32);

function escrowCall(source: string, fn: string, contract = ESCROW, args: any[] = [nativeToScVal(Buffer.from(TRADE, 'hex'))], fee = '100'): Transaction {
  return new TransactionBuilder(new Account(source, '1'), { fee, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(30)
    .build();
}

const addr = (g: string) => nativeToScVal(new Address(g), { type: 'address' });
const bytes = (hex: string) => nativeToScVal(Buffer.from(hex, 'hex'));

describe('the SEP-24 fixture driver, its pure parts', () => {
  it('signs a SEP-53 nonce exactly the way the coordinator verifies it', () => {
    const nonce = 'abc123';
    const sig = sep53Signature(kp, nonce);
    const payload = Buffer.concat([Buffer.from('Stellar Signed Message:\n', 'utf8'), Buffer.from(nonce, 'utf8')]);
    expect(kp.verify(createHash('sha256').update(payload).digest(), Buffer.from(sig, 'base64'))).toBe(true);
  });

  it('signs only for testnet, whatever passphrase a server hands back', () => {
    expect(() => assertTestnet(TESTNET_PASSPHRASE)).not.toThrow();
    expect(() => assertTestnet(Networks.PUBLIC)).toThrow(/refusing to sign for network/);
  });

  it('reads a SEP-10 challenge the way a wallet does, and refuses one that names another account', () => {
    const server = Keypair.random();
    expect(() => readChallenge(challengeFrom(server, kp.publicKey()), server.publicKey(), HOME, WEB_AUTH, kp.publicKey())).not.toThrow();
    expect(() =>
      readChallenge(challengeFrom(server, Keypair.random().publicKey()), server.publicKey(), HOME, WEB_AUTH, kp.publicKey()),
    ).toThrow(/names/);
    expect(() =>
      readChallenge(challengeFrom(server, kp.publicKey()), Keypair.random().publicKey(), HOME, WEB_AUTH, kp.publicKey()),
    ).toThrow();
  });

  it('adds only the client signature to a valid challenge and leaves the server signature intact', () => {
    const server = Keypair.random();
    const back = new Transaction(
      signSep10Challenge(challengeFrom(server, kp.publicKey()), kp, server.publicKey(), HOME, WEB_AUTH),
      Networks.TESTNET,
    ) as any;
    expect(back.signatures).toHaveLength(2);
  });

  it('signs an escrow call only when it is sourced on the signer, invokes the named contract, and calls the named function', () => {
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'confirm_and_release'), kp.publicKey(), ESCROW, 'confirm_and_release')).not.toThrow();
    expect(() => assertEscrowCall(escrowCall(Keypair.random().publicKey(), 'confirm_and_release'), kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/source/);
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'confirm_and_release'), kp.publicKey(), ESCROW, 'create_trade')).toThrow(/function/);
    const other = 'CAVJAMGCIBSMSA6Q3JQYHAF3CGWTM4XQNZ3TJHUWSU5NISHK6UHRHA3N';
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'confirm_and_release', other), kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/contract/);
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'create_trade'), kp.publicKey(), ESCROW, 'create_trade')).toThrow(/expected 15/);
    const stringId = escrowCall(kp.publicKey(), 'confirm_and_release', ESCROW, [nativeToScVal('x'.repeat(32))]);
    expect(() => assertEscrowCall(stringId, kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/not 32 bytes/);
    const longId = escrowCall(kp.publicKey(), 'confirm_and_release', ESCROW, [bytes('ab'.repeat(33))]);
    expect(() => assertEscrowCall(longId, kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/not 32 bytes/);
    const dear = escrowCall(kp.publicKey(), 'confirm_and_release', ESCROW, undefined, String(MAX_ATTEST_FEE_STROOPS + 1));
    expect(() => assertEscrowCall(dear, kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/fee/);
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'confirm_and_release', ESCROW, undefined, String(MAX_ATTEST_FEE_STROOPS)), kp.publicKey(), ESCROW, 'confirm_and_release')).not.toThrow();
    const payment = new TransactionBuilder(new Account(kp.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
      .setTimeout(30)
      .build();
    expect(() => assertEscrowCall(payment, kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/invokeHostFunction/);
  });

  it('pins every argument that names a party or moves money: trade, provider, recipient, fee wallet, amount ceiling, caller', () => {
    const lp = kp.publicKey();
    const demo = Keypair.random().publicKey();
    const other = Keypair.random().publicKey();
    const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
    const u32Max = nativeToScVal(4_294_967_295, { type: 'u32' });
    const u64Max = nativeToScVal(18_446_744_073_709_551_615n, { type: 'u64' });
    const i128Max = i128(170_141_183_460_469_231_731_687_303_715_884_105_727n);
    const createArgs = (provider: string, recipient: string, lpWallet = lp, amount: any = i128(125_000_000n), trade = TRADE) => [
      bytes(trade), addr(provider), addr(recipient), addr(provider), amount, i128Max, nativeToScVal('XXX', { type: 'symbol' }), u32Max, u32Max, u32Max, addr(other), addr(lpWallet), u64Max, u64Max, u64Max,
    ];
    const create = (...a: Parameters<typeof createArgs>) => escrowCall(lp, 'create_trade', ESCROW, createArgs(...a));
    const want = { tradeIdHex: TRADE, provider: lp, recipient: demo, lpWallet: lp, usdcStroops: 125_000_000n, maxUsdcStroops: 1_000_000_000n };
    expect(assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', want)).toBe(TRADE);
    expect(() => assertEscrowCall(create(lp, other), lp, ESCROW, 'create_trade', want)).toThrow(/recipient/);
    expect(() => assertEscrowCall(create(other, demo), lp, ESCROW, 'create_trade', want)).toThrow(/provider/);
    expect(() => assertEscrowCall(create(lp, demo, other), lp, ESCROW, 'create_trade', want)).toThrow(/pays the LP fee to/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(1_000_000_001n)), lp, ESCROW, 'create_trade', want)).toThrow(/above the demo ceiling/);
    expect(assertEscrowCall(create(lp, demo, lp, i128(1_000_000_000n)), lp, ESCROW, 'create_trade', { ...want, usdcStroops: 1_000_000_000n })).toBe(TRADE);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(124_000_000n)), lp, ESCROW, 'create_trade', want)).toThrow(/the assignment quoted/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(-5n)), lp, ESCROW, 'create_trade', want)).toThrow(/not positive/);
    expect(() => assertEscrowCall(create(lp, demo, lp, nativeToScVal('1')), lp, ESCROW, 'create_trade', want)).toThrow(/not scvI128/);
    expect(() => assertEscrowCall(create(lp, demo, lp, nativeToScVal(true)), lp, ESCROW, 'create_trade', want)).toThrow(/not scvI128/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), 'cd'.repeat(32)), lp, ESCROW, 'create_trade', want)).toThrow(/names trade/);
    expect(() => assertEscrowCall(escrowCall(lp, 'create_trade', ESCROW, [...createArgs(lp, demo), u32Max]), lp, ESCROW, 'create_trade', want)).toThrow(/expected 15/);

    const mark = (caller: string, trade = TRADE) => escrowCall(demo, 'mark_fiat_paid', ESCROW, [bytes(trade), addr(caller)]);
    expect(assertEscrowCall(mark(demo), demo, ESCROW, 'mark_fiat_paid', { tradeIdHex: TRADE })).toBe(TRADE);
    expect(() => assertEscrowCall(mark(other), demo, ESCROW, 'mark_fiat_paid', { tradeIdHex: TRADE })).toThrow(/caller/);
    expect(() => assertEscrowCall(mark(demo, 'cd'.repeat(32)), demo, ESCROW, 'mark_fiat_paid', { tradeIdHex: TRADE })).toThrow(/names trade/);

    const release = (trade = TRADE) => escrowCall(lp, 'confirm_and_release', ESCROW, [bytes(trade)]);
    expect(assertEscrowCall(release(), lp, ESCROW, 'confirm_and_release', { tradeIdHex: TRADE })).toBe(TRADE);
    expect(() => assertEscrowCall(release('cd'.repeat(32)), lp, ESCROW, 'confirm_and_release', { tradeIdHex: TRADE })).toThrow(/names trade/);
  });

  it('picks exactly the fresh MATCHED order for the demo account, never a stale one', () => {
    const me = kp.publicKey();
    const t0 = Date.parse('2026-09-03T05:00:00Z');
    const fresh = { id: 'new', status: 'MATCHED', user_address: me, created_at: '2026-09-03T05:00:10Z' };
    const stale = { id: 'old', status: 'MATCHED', user_address: me, created_at: '2026-09-03T04:00:00Z' };
    const funded = { id: 'funded', status: 'FUNDED', user_address: me, created_at: '2026-09-03T05:00:20Z' };
    const someone = { id: 'theirs', status: 'MATCHED', user_address: 'GOTHER', created_at: '2026-09-03T05:00:30Z' };
    expect(pickFreshOrder([stale, fresh, funded, someone], me, t0).id).toBe('new');
    expect(() => pickFreshOrder([stale, funded, someone], me, t0)).toThrow(/found 0/);
    expect(() => pickFreshOrder([fresh, { ...fresh, id: 'new2' }], me, t0)).toThrow(/found 2/);
  });

  it('assembles a deposit-only config and places the secret exactly once', () => {
    const secret = Keypair.random().secret();
    const cfg = assembleSepConfig({
      secret,
      depositPending: { id: 'd1' },
      depositCompleted: { id: 'd2', stellar_transaction_id: 'h2' },
    });
    expect(cfg['24'].depositPendingTransaction).toEqual({ id: 'd1', status: 'pending_user_transfer_start' });
    expect(cfg['24'].depositCompletedTransaction).toEqual({ id: 'd2', status: 'completed', stellar_transaction_id: 'h2' });
    expect(cfg['24']).not.toHaveProperty('withdrawPendingUserTransferStartTransaction');
    expect(JSON.stringify(cfg).split(secret).length - 1).toBe(1);
  });
});
