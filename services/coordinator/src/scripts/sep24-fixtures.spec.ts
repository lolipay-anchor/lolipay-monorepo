import { Account, Address, Asset, Contract, Keypair, Networks, Operation, Transaction, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import {
  MAX_DEMO_FEE_STROOPS,
  MAX_DEMO_USDC_STROOPS,
  MIN_PLAUSIBLE_IDR_PER_USDC,
  TESTNET_PASSPHRASE,
  assembleSepConfig,
  createTradeExpectation,
  createWithdrawExpectation,
  expectedSep24Record,
  usdcNeededFor,
  usdcBalanceOf,
  demoIdrDigits,
  assertEscrowCall,
  assertTestnet,
  pickFreshOrder,
  readChallenge,
  sep53Signature,
  signSep10Challenge,
  roleTarget,
  newestMatchedOrder,
  orderAwaitingRelease,
  fundedOrderOf,
  fundedByMe,
  resumeNeedsFunding,
  RefusedToSign,
  assertTradeParties,
  staleMatchedFor,
  resumeAfterFailedFunding,
  partiesOf,
  withAttempts,
  screenFromTitle,
} from './sep24-fixtures';
import { FIAT_INPUT_REFUSAL } from '../money/money';

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
  const built = new TransactionBuilder(new Account(source, '1'), { fee, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(30)
    .build();
  return new Transaction(built.toXdr(), Networks.TESTNET);
}

const PAY = 1_700_000_600n;
const CONFIRM = 1_700_003_600n;
const DISPUTE = 1_700_090_000n;
const FIAT = 200_000n;
const PIN = { tradeIdHex: TRADE };

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
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'confirm_and_release'), kp.publicKey(), ESCROW, 'confirm_and_release', PIN)).not.toThrow();
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'confirm_and_release'), kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/carries no tradeIdHex/);
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'confirm_and_release'), kp.publicKey(), ESCROW, 'confirm_and_release', {})).toThrow(/carries no tradeIdHex/);
    expect(() => assertEscrowCall(escrowCall(Keypair.random().publicKey(), 'confirm_and_release'), kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/source/);
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'confirm_and_release'), kp.publicKey(), ESCROW, 'create_trade')).toThrow(/function/);
    const other = 'CAVJAMGCIBSMSA6Q3JQYHAF3CGWTM4XQNZ3TJHUWSU5NISHK6UHRHA3N';
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'confirm_and_release', other), kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/contract/);
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'create_trade'), kp.publicKey(), ESCROW, 'create_trade', PIN)).toThrow(/expected 15/);
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'raise_dispute'), kp.publicKey(), ESCROW, 'raise_dispute', PIN)).toThrow(/not a call this driver signs/);
    const stringId = escrowCall(kp.publicKey(), 'confirm_and_release', ESCROW, [nativeToScVal('x'.repeat(32))]);
    expect(() => assertEscrowCall(stringId, kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/not scvBytes/);
    const longId = escrowCall(kp.publicKey(), 'confirm_and_release', ESCROW, [bytes('ab'.repeat(33))]);
    expect(() => assertEscrowCall(longId, kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/not 32 bytes/);
    const dear = escrowCall(kp.publicKey(), 'confirm_and_release', ESCROW, undefined, String(MAX_DEMO_FEE_STROOPS + 1n));
    expect(() => assertEscrowCall(dear, kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/fee/);
    expect(() => assertEscrowCall(escrowCall(kp.publicKey(), 'confirm_and_release', ESCROW, undefined, String(MAX_DEMO_FEE_STROOPS)), kp.publicKey(), ESCROW, 'confirm_and_release', PIN)).not.toThrow();
    const payment = new TransactionBuilder(new Account(kp.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
      .setTimeout(30)
      .build();
    expect(() => assertEscrowCall(payment, kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/invokeHostFunction/);
    const upload = new Transaction(
      new TransactionBuilder(new Account(kp.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.uploadContractWasm({ wasm: Buffer.from([0]) }))
        .setTimeout(30)
        .build()
        .toXdr(),
      Networks.TESTNET,
    );
    expect(() => assertEscrowCall(upload, kp.publicKey(), ESCROW, 'confirm_and_release')).toThrow(/invoke a contract/);
  });

  it('pins every argument that names a party or moves money: trade, provider, recipient, fee wallet, amount ceiling, caller', () => {
    const lp = kp.publicKey();
    const demo = Keypair.random().publicKey();
    const other = Keypair.random().publicKey();
    const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });
    const u32Max = nativeToScVal(4_294_967_295, { type: 'u32' });
    const u64Max = nativeToScVal(18_446_744_073_709_551_615n, { type: 'u64' });
    const i128Max = i128(170_141_183_460_469_231_731_687_303_715_884_105_727n);
    const platform = Keypair.random().publicKey();
    const u32 = (n: number) => nativeToScVal(n, { type: 'u32' });
    const u64 = (n: bigint) => nativeToScVal(n, { type: 'u64' });
    const sym = (v: string) => nativeToScVal(v, { type: 'symbol' });
    const createArgs = (
      provider: string,
      recipient: string,
      lpWallet = lp,
      amount: any = i128(125_000_000n),
      trade = TRADE,
      flow: any = u32(0),
      pay: any = u64(PAY),
      confirm: any = u64(CONFIRM),
      fiat: any = i128(FIAT),
      currency: any = sym('IDR'),
      lpFee: any = u32(20),
      dispute: any = u64(DISPUTE),
      confirmer: any = addr(provider),
    ) => [bytes(trade), addr(provider), addr(recipient), confirmer, amount, fiat, currency, flow, u32Max, lpFee, addr(platform), addr(lpWallet), pay, confirm, dispute];
    const create = (...a: Parameters<typeof createArgs>) => escrowCall(lp, 'create_trade', ESCROW, createArgs(...a));
    const want = {
      tradeIdHex: TRADE, flow: 0 as const, provider: lp, recipient: demo, confirmer: lp, lpWallet: lp, usdcStroops: 125_000_000n, maxUsdcStroops: 1_000_000_000n,
      fiatAmount: FIAT, fiatCurrency: 'IDR', lpFeeBps: 20, payDeadline: PAY, confirmDeadline: CONFIRM, disputeDeadline: DISPUTE,
    };
    const A = i128(125_000_000n);
    expect(assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', want)).toBe(TRADE);
    expect(() => assertEscrowCall(create(lp, other), lp, ESCROW, 'create_trade', want)).toThrow(/recipient/);
    expect(() => assertEscrowCall(create(other, demo), lp, ESCROW, 'create_trade', want)).toThrow(/provider/);
    expect(() => assertEscrowCall(create(lp, demo, lp, A, TRADE, u32(0), u64(PAY), u64(CONFIRM), i128(FIAT), sym('IDR'), u32(20), u64(DISPUTE), addr(other)), lp, ESCROW, 'create_trade', want)).toThrow(/names confirmer/);
    expect(() => assertEscrowCall(create(lp, demo, other), lp, ESCROW, 'create_trade', want)).toThrow(/pays the LP fee to/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(1_000_000_001n)), lp, ESCROW, 'create_trade', want)).toThrow(/above the demo ceiling/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(1_000_000_000n)), lp, ESCROW, 'create_trade', { ...want, usdcStroops: 1_000_000_000n })).toThrow(/below 10000 IDR per USDC/);
    expect(
      assertEscrowCall(create(lp, demo, lp, i128(1_000_000_000n), TRADE, u32(0), u64(PAY), u64(CONFIRM), i128(1_000_000n)), lp, ESCROW, 'create_trade', { ...want, usdcStroops: 1_000_000_000n, fiatAmount: 1_000_000n }),
    ).toBe(TRADE);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(124_000_000n)), lp, ESCROW, 'create_trade', want)).toThrow(/the assignment quoted/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(-5n)), lp, ESCROW, 'create_trade', want)).toThrow(/not positive/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(0n)), lp, ESCROW, 'create_trade', want)).toThrow(/not positive/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), TRADE, u32(1)), lp, ESCROW, 'create_trade', want)).toThrow(/not the deposit discriminant/);
    expect(assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), TRADE, u32(1)), lp, ESCROW, 'create_trade', { ...want, flow: 1 })).toBe(TRADE);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, flow: 1 })).toThrow(/not the withdrawal discriminant \(u32 1\)/);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, flow: undefined })).toThrow(/carries no flow;/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), TRADE, nativeToScVal(0, { type: 'i32' })), lp, ESCROW, 'create_trade', want)).toThrow(/not the deposit discriminant/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), TRADE, u32(0), u64(PAY + 1n)), lp, ESCROW, 'create_trade', want)).toThrow(/pay_deadline .* the assignment quoted/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), TRADE, u32(0), u64(PAY), u64(CONFIRM - 1n)), lp, ESCROW, 'create_trade', want)).toThrow(/confirm_deadline .* the assignment quoted/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), TRADE, u32(0), u32(1_700_000_600)), lp, ESCROW, 'create_trade', want)).toThrow(/deadlines are not u64/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), TRADE, u32(0), u64(PAY), u32(1_700_003_600)), lp, ESCROW, 'create_trade', want)).toThrow(/deadlines are not u64/);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, payDeadline: undefined })).toThrow(/carries no payDeadline;/);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, lpWallet: undefined, confirmDeadline: undefined })).toThrow(/carries no lpWallet, confirmDeadline;/);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', PIN)).toThrow(
      'carries no flow, provider, recipient, confirmer, lpWallet, usdcStroops, maxUsdcStroops, fiatAmount, fiatCurrency, lpFeeBps, payDeadline, confirmDeadline, disputeDeadline;',
    );
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, provider: '' })).toThrow(/names provider/);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, tradeIdHex: '' })).toThrow(/names trade/);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, recipient: '' })).toThrow(/names recipient/);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, lpWallet: '' })).toThrow(/pays the LP fee to/);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, fiatCurrency: '' })).toThrow(/fiat_currency IDR is not the /);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, lpFeeBps: 0 })).toThrow(/lp_fee_bps 20 is not the 0 /);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, usdcStroops: 0n })).toThrow(/not the 0 the assignment quoted/);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, fiatAmount: 0n })).toThrow(/below 10000 IDR per USDC/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(250_000_000n)), lp, ESCROW, 'create_trade', { ...want, usdcStroops: 250_000_000n })).toThrow(/escrows 250000000 stroops against 200000 IDR, below 10000 IDR per USDC/);
    expect(assertEscrowCall(create(lp, demo, lp, i128(200_000_000n)), lp, ESCROW, 'create_trade', { ...want, usdcStroops: 200_000_000n })).toBe(TRADE);
    expect(() => assertEscrowCall(create(lp, demo, lp, A, TRADE, u32(0), u64(PAY), u64(CONFIRM), i128(FIAT + 1n)), lp, ESCROW, 'create_trade', want)).toThrow(/fiat_amount .* the assignment quoted/);
    expect(() => assertEscrowCall(create(lp, demo, lp, A, TRADE, u32(0), u64(PAY), u64(CONFIRM), u32(200_000)), lp, ESCROW, 'create_trade', want)).toThrow(/fiat amount is scvU32/);
    expect(() => assertEscrowCall(create(lp, demo, lp, A, TRADE, u32(0), u64(PAY), u64(CONFIRM), i128(FIAT), sym('USD')), lp, ESCROW, 'create_trade', want)).toThrow(/fiat_currency .* the assignment quoted/);
    expect(() => assertEscrowCall(create(lp, demo, lp, A, TRADE, u32(0), u64(PAY), u64(CONFIRM), i128(FIAT), nativeToScVal('IDR')), lp, ESCROW, 'create_trade', want)).toThrow(/not scvSymbol/);
    expect(() => assertEscrowCall(create(lp, demo, lp, A, TRADE, u32(0), u64(PAY), u64(CONFIRM), i128(FIAT), sym('IDR'), u32(500)), lp, ESCROW, 'create_trade', want)).toThrow(/lp_fee_bps .* the assignment quoted/);
    expect(() => assertEscrowCall(create(lp, demo, lp, A, TRADE, u32(0), u64(PAY), u64(CONFIRM), i128(FIAT), sym('IDR'), u64(20n)), lp, ESCROW, 'create_trade', want)).toThrow(/lp fee is scvU64/);
    expect(() => assertEscrowCall(create(lp, demo, lp, A, TRADE, u32(0), u64(PAY), u64(CONFIRM), i128(FIAT), sym('IDR'), u32(20), u64(DISPUTE + 1n)), lp, ESCROW, 'create_trade', want)).toThrow(/dispute_deadline .* the assignment quoted/);
    expect(() => assertEscrowCall(create(lp, demo, lp, A, TRADE, u32(0), u64(PAY), u64(CONFIRM), i128(FIAT), sym('IDR'), u32(20), u32(1_700_090_000)), lp, ESCROW, 'create_trade', want)).toThrow(/deadlines are not u64/);
    expect(() => assertEscrowCall(create(lp, demo, lp, nativeToScVal('1')), lp, ESCROW, 'create_trade', want)).toThrow(/not scvI128/);
    expect(() => assertEscrowCall(create(lp, demo, lp, nativeToScVal(true)), lp, ESCROW, 'create_trade', want)).toThrow(/not scvI128/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), 'cd'.repeat(32)), lp, ESCROW, 'create_trade', want)).toThrow(/names trade/);
    expect(() => assertEscrowCall(escrowCall(lp, 'create_trade', ESCROW, [...createArgs(lp, demo), u32Max]), lp, ESCROW, 'create_trade', want)).toThrow(/expected 15/);

    const mark = (caller: string, trade = TRADE) => escrowCall(demo, 'mark_fiat_paid', ESCROW, [bytes(trade), addr(caller)]);
    expect(assertEscrowCall(mark(demo), demo, ESCROW, 'mark_fiat_paid', { tradeIdHex: TRADE })).toBe(TRADE);
    expect(() => assertEscrowCall(mark(demo), demo, ESCROW, 'mark_fiat_paid')).toThrow(/carries no tradeIdHex/);
    expect(() => assertEscrowCall(mark(other), demo, ESCROW, 'mark_fiat_paid', { tradeIdHex: TRADE })).toThrow(/caller/);
    expect(() => assertEscrowCall(mark(demo, 'cd'.repeat(32)), demo, ESCROW, 'mark_fiat_paid', { tradeIdHex: TRADE })).toThrow(/names trade/);

    const release = (trade = TRADE) => escrowCall(lp, 'confirm_and_release', ESCROW, [bytes(trade)]);
    expect(assertEscrowCall(release(), lp, ESCROW, 'confirm_and_release', { tradeIdHex: TRADE })).toBe(TRADE);
    expect(() => assertEscrowCall(release('cd'.repeat(32)), lp, ESCROW, 'confirm_and_release', { tradeIdHex: TRADE })).toThrow(/names trade/);
  });

  it('picks exactly the fresh MATCHED order for the demo account, never a stale one, and only if it carries what the guard will pin', () => {
    const me = kp.publicKey();
    const t0 = Date.parse('2026-09-03T05:00:00Z');
    const fresh = {
      id: 'new', flow: 'TOP_UP', status: 'MATCHED', user_address: me, created_at: '2026-09-03T05:00:10Z', trade_id: TRADE, usdc_amount: '125000000',
      fiat_amount: '200000', fiat_currency: 'IDR', lp_fee_bps: 20, pay_deadline: 1_700_000_600, confirm_deadline: 1_700_003_600, dispute_deadline: 1_700_090_000,
    };
    const stale = { id: 'old', status: 'MATCHED', user_address: me, created_at: '2026-09-03T04:00:00Z' };
    const funded = { id: 'funded', status: 'FUNDED', user_address: me, created_at: '2026-09-03T05:00:20Z' };
    const someone = { id: 'theirs', status: 'MATCHED', user_address: 'GOTHER', created_at: '2026-09-03T05:00:30Z' };
    expect(pickFreshOrder([stale, fresh, funded, someone], me, t0).id).toBe('new');
    expect(() => pickFreshOrder([stale, funded, someone], me, t0)).toThrow(/found 0/);
    expect(() => pickFreshOrder([fresh, { ...fresh, id: 'new2' }], me, t0)).toThrow(/found 2/);
    expect(() => pickFreshOrder([{ ...fresh, trade_id: null }], me, t0)).toThrow(/carries no trade_id;/);
    expect(() => pickFreshOrder([{ ...fresh, usdc_amount: undefined }], me, t0)).toThrow(/carries no usdc_amount;/);
    expect(() => pickFreshOrder([{ ...fresh, pay_deadline: null }], me, t0)).toThrow(/carries no pay_deadline;/);
    expect(() => pickFreshOrder([{ ...fresh, flow: null }], me, t0)).toThrow(/carries no flow;/);
    expect(() => pickFreshOrder([{ ...fresh, confirm_deadline: null }], me, t0)).toThrow(/carries no confirm_deadline;/);
    expect(() => pickFreshOrder([{ ...fresh, fiat_currency: '' }], me, t0)).toThrow(/carries no fiat_currency;/);
    expect(() => pickFreshOrder([{ ...fresh, fiat_amount: null }], me, t0)).toThrow(/carries no fiat_amount;/);
    expect(() => pickFreshOrder([{ ...fresh, dispute_deadline: undefined }], me, t0)).toThrow(/carries no dispute_deadline;/);
    expect(pickFreshOrder([{ ...fresh, lp_fee_bps: 0 }], me, t0).lp_fee_bps).toBe(0);
    expect(() => pickFreshOrder([{ ...fresh, trade_id: null, confirm_deadline: null }], me, t0)).toThrow(/carries no trade_id, confirm_deadline;/);
  });

  it('builds the create_trade expectation with every pin the guard holds and refuses an assignment that quotes a different rupiah amount or currency than the driver asked for', () => {
    const lp = kp.publicKey();
    const demo = Keypair.random().publicKey();
    const order = {
      id: 'o', status: 'MATCHED', flow: 'TOP_UP', created_at: '2026-09-03T05:00:10Z', trade_id: TRADE, usdc_amount: '125000000',
      fiat_amount: '200000', fiat_currency: 'IDR', lp_fee_bps: 20, pay_deadline: 1_700_000_600, confirm_deadline: 1_700_003_600, dispute_deadline: 1_700_090_000,
    };
    expect(() => createTradeExpectation({ ...order, flow: 'WITHDRAW' }, lp, demo, '200000')).toThrow(/is a WITHDRAW order, not the TOP_UP/);
    expect(createTradeExpectation(order, lp, demo, 'Rp 200.000')).toEqual({
      tradeIdHex: TRADE,
      flow: 0,
      provider: lp,
      recipient: demo,
      confirmer: lp,
      lpWallet: lp,
      usdcStroops: 125_000_000n,
      maxUsdcStroops: MAX_DEMO_USDC_STROOPS,
      fiatAmount: 200_000n,
      fiatCurrency: 'IDR',
      lpFeeBps: 20,
      payDeadline: 1_700_000_600n,
      confirmDeadline: 1_700_003_600n,
      disputeDeadline: 1_700_090_000n,
    });
    expect(() => createTradeExpectation({ ...order, fiat_amount: '999' }, lp, demo, '200000')).toThrow(/quotes fiat_amount 999, not the 200000/);
    expect(() => createTradeExpectation({ ...order, fiat_amount: '250000' }, lp, demo, '250,000')).toThrow(FIAT_INPUT_REFUSAL);
    expect(() => createTradeExpectation({ ...order, fiat_amount: '25000000' }, lp, demo, '250000.00')).toThrow(FIAT_INPUT_REFUSAL);
    expect(createTradeExpectation({ ...order, fiat_amount: '250000' }, lp, demo, '250.000').fiatAmount).toBe(250_000n);
    expect(() => createTradeExpectation({ ...order, fiat_amount: '0' }, lp, demo, 'abc')).toThrow(FIAT_INPUT_REFUSAL);
    expect(() => createTradeExpectation({ ...order, fiat_amount: '0' }, lp, demo, '0')).toThrow(/carries no rupiah digits/);
    expect(() => createTradeExpectation({ ...order, fiat_currency: 'USD' }, lp, demo, '200000')).toThrow(/quotes fiat_currency USD, not the IDR/);
  });

  it('builds the withdrawal expectation with the parties reversed: the demo provides and confirms, the provider receives and takes the fee, flow 1', () => {
    const lp = kp.publicKey();
    const demo = Keypair.random().publicKey();
    const order = {
      id: 'w', status: 'MATCHED', flow: 'WITHDRAW', created_at: '2026-09-04T19:00:10Z', trade_id: TRADE, usdc_amount: '85090000',
      fiat_amount: '150000', fiat_currency: 'IDR', lp_fee_bps: 120, pay_deadline: 1_700_000_600, confirm_deadline: 1_700_003_600, dispute_deadline: 1_700_090_000,
    };
    expect(createWithdrawExpectation(order, lp, demo, '150.000')).toEqual({
      tradeIdHex: TRADE,
      flow: 1,
      provider: demo,
      recipient: lp,
      confirmer: demo,
      lpWallet: lp,
      usdcStroops: 85_090_000n,
      maxUsdcStroops: MAX_DEMO_USDC_STROOPS,
      fiatAmount: 150_000n,
      fiatCurrency: 'IDR',
      lpFeeBps: 120,
      payDeadline: 1_700_000_600n,
      confirmDeadline: 1_700_003_600n,
      disputeDeadline: 1_700_090_000n,
    });
    expect(() => createWithdrawExpectation({ ...order, flow: 'TOP_UP' }, lp, demo, '150000')).toThrow(/is a TOP_UP order, not the WITHDRAW/);
    expect(() => createWithdrawExpectation({ ...order, fiat_amount: '999' }, lp, demo, '150000')).toThrow(/quotes fiat_amount 999, not the 150000/);
    expect(() => createWithdrawExpectation(order, lp, demo, '150,000')).toThrow(FIAT_INPUT_REFUSAL);
  });

  it('names the record a withdrawal must show: gross USDC in, the Stellar asset; a deposit shows the rupiah and iso4217', () => {
    const issuer = Keypair.random().publicKey();
    expect(expectedSep24Record('WITHDRAW', '85090000', '150000', issuer)).toEqual({ amountIn: '8.5090000', asset: `stellar:USDC:${issuer}` });
    expect(expectedSep24Record('TOP_UP', '85090000', '150000', issuer)).toEqual({ amountIn: '150000', asset: 'iso4217:IDR' });
  });

  it('asks for ten percent more USDC than the display rate implies before opening a withdrawal, which covers a sell-side spread up to several hundred basis points', () => {
    expect(usdcNeededFor('150000', '16240')).toBe(101_600_987n);
    expect(usdcNeededFor('160000', '16000')).toBe(110_000_000n);
  });

  it('reads the USDC balance of the issuer it was told, never another issuer\'s USDC', () => {
    const issuer = Keypair.random().publicKey();
    const other = Keypair.random().publicKey();
    const balances = [
      { asset_type: 'native', balance: '9999.0000000' },
      { asset_code: 'USDC', asset_issuer: other, balance: '500.0000000' },
      { asset_code: 'USDC', asset_issuer: issuer, balance: '11.0200000' },
    ];
    expect(usdcBalanceOf(balances, issuer)).toBe(110_200_000n);
    expect(usdcBalanceOf(balances.slice(0, 2), issuer)).toBe(0n);
    expect(usdcBalanceOf([{ asset_code: 'USDC', asset_issuer: issuer, balance: '3' }], issuer)).toBe(30_000_000n);
  });

  it('refuses an ambiguous demo amount before anything is opened, with the same words the anchor would answer', () => {
    expect(() => demoIdrDigits('200,000')).toThrow(FIAT_INPUT_REFUSAL);
    expect(() => demoIdrDigits('150000.00')).toThrow(FIAT_INPUT_REFUSAL);
    expect(() => demoIdrDigits('abc')).toThrow(FIAT_INPUT_REFUSAL);
    expect(() => demoIdrDigits('')).toThrow(FIAT_INPUT_REFUSAL);
    expect(() => demoIdrDigits('9'.repeat(19))).toThrow(FIAT_INPUT_REFUSAL);
    expect(demoIdrDigits('rp 200.000')).toBe('200000');
    expect(demoIdrDigits('9'.repeat(18))).toBe('9'.repeat(18));
    expect(demoIdrDigits('200.000')).toBe('200000');
  });

  it('still loads as a module when the env carries a refused amount, so a bad value fails the run in main and not every test in this file', () => {
    const previous = process.env.SEP24_DEMO_IDR;
    process.env.SEP24_DEMO_IDR = '200,000';
    try {
      jest.isolateModules(() => {
        expect(require('./sep24-fixtures').DEMO_IDR_DIGITS).toBe('0');
      });
    } finally {
      if (previous === undefined) delete process.env.SEP24_DEMO_IDR;
      else process.env.SEP24_DEMO_IDR = previous;
    }
  });

  it('canonicalises a plain-digit demo amount the way the record will echo it, so a leading zero cannot refuse an honest run', () => {
    expect(demoIdrDigits('0200000')).toBe('200000');
    expect(demoIdrDigits('Rp 200.000')).toBe('200000');
    const previous = process.env.SEP24_DEMO_IDR;
    process.env.SEP24_DEMO_IDR = 'Rp 0300000';
    try {
      jest.isolateModules(() => {
        expect(require('./sep24-fixtures').DEMO_IDR_DIGITS).toBe('300000');
      });
    } finally {
      if (previous === undefined) delete process.env.SEP24_DEMO_IDR;
      else process.env.SEP24_DEMO_IDR = previous;
    }
  });

  it('holds the ceilings that bound a compromised coordinator, 100 USDC, 1 XLM and 10,000 IDR per USDC, so changing any is a decision with a test to edit', () => {
    expect(MAX_DEMO_USDC_STROOPS).toBe(1_000_000_000n);
    expect(MAX_DEMO_FEE_STROOPS).toBe(10_000_000n);
    expect(MIN_PLAUSIBLE_IDR_PER_USDC).toBe(10_000n);
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
    expect(cfg['24']).not.toHaveProperty('withdrawCompletedTransaction');
    expect(JSON.stringify(cfg).split(secret).length - 1).toBe(1);
  });

  it('adds the completed withdrawal fixture when the run produced one, and never a pending-withdrawal one, which would send a wallet to a null anchor account', () => {
    const secret = Keypair.random().secret();
    const cfg = assembleSepConfig({
      secret,
      depositPending: { id: 'd1' },
      depositCompleted: { id: 'd2', stellar_transaction_id: 'h2' },
      withdrawCompleted: { id: 'w1', stellar_transaction_id: 'h3' },
    });
    expect(cfg['24'].withdrawCompletedTransaction).toEqual({ id: 'w1', status: 'completed', stellar_transaction_id: 'h3' });
    expect(cfg['24']).not.toHaveProperty('withdrawPendingUserTransferStartTransaction');
    expect(JSON.stringify(cfg).split(secret).length - 1).toBe(1);
  });
});

describe('the SEP-24 fixture driver, its two roles', () => {
  it('runs as today when no role is named, and refuses a role it does not know', () => {
    expect(roleTarget({})).toBeNull();
    expect(roleTarget({ SEP24_ROLE: '' })).toBeNull();
    expect(() => roleTarget({ SEP24_ROLE: 'attestor' })).toThrow('SEP24_ROLE must be "lp" or "user"');
  });

  it('as the provider, funds only for the wallet it was told, and refuses a malformed or checksum-invalid one', () => {
    const pub = Keypair.random().publicKey();
    expect(roleTarget({ SEP24_ROLE: 'lp', SEP24_USER_PUB: pub })).toEqual({ role: 'lp', userPub: pub, orderId: null, waitMs: 65 * 60_000, waitsForAttest: false });
    expect(() => roleTarget({ SEP24_ROLE: 'lp' })).toThrow('SEP24_USER_PUB must be the G address');
    expect(() => roleTarget({ SEP24_ROLE: 'lp', SEP24_USER_PUB: pub.slice(0, 55) + (pub[55] === 'A' ? 'B' : 'A') })).toThrow('SEP24_USER_PUB must be the G address');
    expect(() => roleTarget({ SEP24_ROLE: 'lp', SEP24_USER_PUB: pub, SEP24_ROLE_WAIT_MINUTES: '0' })).toThrow('positive number of minutes');
    expect(roleTarget({ SEP24_ROLE: 'lp', SEP24_USER_PUB: pub, SEP24_ROLE_WAIT_MINUTES: '10', SEP24_ORDER_ID: ' o-9 ' })).toMatchObject({ waitMs: 600_000, orderId: 'o-9' });
  });

  it('as the user, needs no counterparty address and can be told to wait for the admin attestation instead of signing', () => {
    expect(roleTarget({ SEP24_ROLE: 'user' })).toEqual({ role: 'user', userPub: null, orderId: null, waitMs: 65 * 60_000, waitsForAttest: false });
    expect(roleTarget({ SEP24_ROLE: 'user', SEP24_USER_WAITS_FOR_ATTEST: '1' })!.waitsForAttest).toBe(true);
    expect(() => roleTarget({ SEP24_ROLE: 'user', SEP24_ORDER_ID: 'o-1' })).toThrow('SEP24_ORDER_ID applies only to the provider role');
    expect(() => roleTarget({ SEP24_ROLE: 'user', SEP24_ROLE_WAIT_MINUTES: 'abc' })).toThrow('positive number of minutes');
  });

  it('as the provider resuming an order, funds one that is still matched, continues one already funded, and refuses any other', () => {
    expect(resumeNeedsFunding('MATCHED')).toBe(true);
    expect(resumeNeedsFunding('AWAITING_ONCHAIN')).toBe(true);
    expect(resumeNeedsFunding('FUNDED')).toBe(false);
    expect(resumeNeedsFunding('FIAT_PAID')).toBe(false);
    for (const status of ['RELEASED', 'REFUNDED', 'CANCELLED', 'EXPIRED', 'DISPUTED']) {
      expect(() => resumeNeedsFunding(status)).toThrow(`an order that is ${status} cannot be resumed by the provider`);
    }
  });

  it('funds the newest fresh MATCHED order for the wallet when the customer retried, and none when there is none', () => {
    const pub = Keypair.random().publicKey();
    const full = { trade_id: 'ab'.repeat(32), flow: 'TOP_UP', usdc_amount: '111700000', fiat_amount: '200000', fiat_currency: 'IDR', lp_fee_bps: 120, pay_deadline: 1, confirm_deadline: 2, dispute_deadline: 3 };
    const older = { id: 'o1', status: 'MATCHED', user_address: pub, created_at: '2026-09-05T12:00:00.000Z', ...full };
    const newer = { id: 'o2', status: 'MATCHED', user_address: pub, created_at: '2026-09-05T12:05:00.000Z', ...full };
    const t0 = Date.parse('2026-09-05T11:59:00.000Z');
    expect(newestMatchedOrder([older, newer], pub, t0)!.id).toBe('o2');
    expect(newestMatchedOrder([{ ...older, status: 'FUNDED' }], pub, t0)).toBeNull();
    expect(pickFreshOrder([{ ...older, status: 'AWAITING_ONCHAIN' }], pub, t0).id).toBe('o1');
    expect(newestMatchedOrder([], pub, t0)).toBeNull();
  });

  it('releases only an order the rupiah was attested for, keeps waiting while it is funded, and refuses one that went elsewhere', () => {
    const base = { created_at: '2026-09-05T12:00:00.000Z' };
    const paid = { id: 'o1', status: 'FIAT_PAID', ...base };
    expect(orderAwaitingRelease([{ id: 'o0', status: 'FIAT_PAID', ...base }, paid], 'o1')).toBe(paid);
    for (const status of ['MATCHED', 'AWAITING_ONCHAIN', 'FUNDED']) expect(orderAwaitingRelease([{ id: 'o1', status, ...base }], 'o1')).toBeNull();
    expect(() => orderAwaitingRelease([], 'o1')).toThrow("order o1 is no longer among this provider's assignments, which list only MATCHED, AWAITING_ONCHAIN, FUNDED and FIAT_PAID");
    for (const status of ['CANCELLED', 'EXPIRED', 'REFUNDED', 'RELEASED', 'DISPUTED']) {
      expect(() => orderAwaitingRelease([{ id: 'o1', status, ...base }], 'o1')).toThrow(`order o1 is ${status}; the provider will not release it`);
    }
  });

  it('as the user, finds its own newest funded deposit and its trade id, and nothing when none is funded', () => {
    const pub = Keypair.random().publicKey();
    const rows = [
      { id: 'a', status: 'FUNDED', flow: 'TOP_UP', trade_id: 'cd'.repeat(32), user_address: pub, created_at: '2026-09-05T12:00:00.000Z' },
      { id: 'b', status: 'FUNDED', flow: 'TOP_UP', trade_id: 'ef'.repeat(32), user_address: pub, created_at: '2026-09-05T12:09:00.000Z' },
      { id: 'c', status: 'FUNDED', flow: 'WITHDRAW', trade_id: '01'.repeat(32), user_address: pub, created_at: '2026-09-05T12:10:00.000Z' },
    ];
    expect(fundedOrderOf(rows, pub)).toEqual({ id: 'b', tradeIdHex: 'ef'.repeat(32) });
    expect(fundedOrderOf(rows.map((r) => ({ ...r, status: 'MATCHED' })), pub)).toBeNull();
  });

  it('as the provider, adopts an escrow it funded but never saw confirmed, so a lost confirmation does not strand the money', () => {
    const pub = Keypair.random().publicKey();
    const t0 = Date.parse('2026-09-05T11:59:00.000Z');
    const rows = [
      { id: 'a', status: 'FUNDED', flow: 'TOP_UP', user_address: pub, trade_id: '11'.repeat(32), created_at: '2026-09-05T12:00:00.000Z' },
      { id: 'b', status: 'MATCHED', flow: 'TOP_UP', user_address: pub, trade_id: '22'.repeat(32), created_at: '2026-09-05T12:09:00.000Z' },
      { id: 'u', status: 'AWAITING_ONCHAIN', flow: 'TOP_UP', user_address: pub, trade_id: '55'.repeat(32), created_at: '2026-09-05T12:11:00.000Z' },
      { id: 'old', status: 'FUNDED', flow: 'TOP_UP', user_address: pub, trade_id: '33'.repeat(32), created_at: '2026-09-05T11:00:00.000Z' },
      { id: 'w', status: 'FUNDED', flow: 'WITHDRAW', user_address: pub, trade_id: '44'.repeat(32), created_at: '2026-09-05T12:10:00.000Z' },
    ];
    expect(fundedByMe(rows, pub, t0)).toEqual({ id: 'a', tradeIdHex: '11'.repeat(32) });
    expect(fundedByMe(rows, Keypair.random().publicKey(), t0)).toBeNull();
  });
});

describe('what the provider refuses for good and what it merely waits out', () => {
  it('refuses to sign for good when the network or the call is not what it was told, but a mistyped amount is only waited out', () => {
    expect(() => assertTestnet('Public Global Stellar Network ; September 2015')).toThrow(RefusedToSign);
    const lp = Keypair.random().publicKey();
    const order = {
      id: 'o1', status: 'MATCHED', created_at: '2026-09-05T12:00:00.000Z', trade_id: 'ab'.repeat(32), flow: 'TOP_UP', usdc_amount: '111700000',
      fiat_amount: '150000', fiat_currency: 'IDR', lp_fee_bps: 120, pay_deadline: 1, confirm_deadline: 2, dispute_deadline: 3, user_address: Keypair.random().publicKey(),
    };
    let caught: unknown;
    try {
      createTradeExpectation(order as any, lp, order.user_address, '200000');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(RefusedToSign);
    expect((caught as Error).message).toBe('assignment o1 quotes fiat_amount 150000, not the 200000 the driver asked for');
  });

  it('after a failed resume funding, gives up on a refusal it was right to make, and otherwise continues only with an order the feed now says is funded', () => {
    const refusal = new RefusedToSign('create_trade names recipient G..., not the wallet');
    const blip = new Error('tx/create-trade: HTTP 502');
    const funded = { id: 'o1', status: 'FUNDED', trade_id: 'ab'.repeat(32), created_at: '2026-09-05T12:00:00.000Z' };
    expect(() => resumeAfterFailedFunding(refusal, funded)).toThrow(refusal);
    expect(resumeAfterFailedFunding(blip, funded)).toBe('ab'.repeat(32));
    expect(() => resumeAfterFailedFunding(blip, { ...funded, status: 'MATCHED' })).toThrow(blip);
    expect(() => resumeAfterFailedFunding(blip, { ...funded, status: 'RELEASED' })).toThrow(blip);
    expect(() => resumeAfterFailedFunding(blip, undefined)).toThrow(blip);
  });

  it('reads the two parties out of a decoded trade, and refuses anything that is not a trade', () => {
    const lp = Keypair.random().publicKey();
    const user = Keypair.random().publicKey();
    expect(partiesOf({ usdc_provider: lp, usdc_recipient: user, status: 1 })).toEqual({ usdcProvider: lp, usdcRecipient: user });
    for (const bad of [undefined, null, 7, 'x', [], { usdc_provider: lp }, { usdc_recipient: user }]) {
      expect(() => partiesOf(bad)).toThrow('get_trade returned something that is not a trade');
    }
  });

  it('releases only a trade the chain says this provider funded for the wallet it serves', () => {
    const lp = Keypair.random().publicKey();
    const user = Keypair.random().publicKey();
    expect(() => assertTradeParties({ usdcProvider: lp, usdcRecipient: user }, lp, user)).not.toThrow();
    expect(() => assertTradeParties({ usdcProvider: Keypair.random().publicKey(), usdcRecipient: user }, lp, user)).toThrow(RefusedToSign);
    expect(() => assertTradeParties({ usdcProvider: lp, usdcRecipient: Keypair.random().publicKey() }, lp, user)).toThrow(RefusedToSign);
  });

  it('names a matched order that predates this run instead of waiting on it in silence', () => {
    const pub = Keypair.random().publicKey();
    const t0 = Date.parse('2026-09-05T12:00:00.000Z');
    const rows = [
      { id: 'old', status: 'MATCHED', flow: 'TOP_UP', user_address: pub, created_at: '2026-09-05T11:50:00.000Z' },
      { id: 'other', status: 'MATCHED', flow: 'TOP_UP', user_address: Keypair.random().publicKey(), created_at: '2026-09-05T11:55:00.000Z' },
    ];
    expect(staleMatchedFor(rows, pub, t0)).toEqual({ id: 'old', createdAt: '2026-09-05T11:50:00.000Z' });
    expect(staleMatchedFor([{ ...rows[0], created_at: '2026-09-05T12:01:00.000Z' }], pub, t0)).toBeNull();
    expect(staleMatchedFor([{ ...rows[0], status: 'FUNDED' }], pub, t0)).toBeNull();
    expect(staleMatchedFor([{ ...rows[0], flow: 'WITHDRAW' }], pub, t0)).toBeNull();
    expect(staleMatchedFor([], pub, t0)).toBeNull();
  });
});

describe('a chain read that sits between a human and the money tries again before giving up', () => {
  it('returns the first success, retries a transient failure, and surfaces the last error after the final attempt', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new Error(`Account not found (attempt ${calls})`);
      return 'ok';
    };
    await expect(withAttempts(flaky, 3, 0)).resolves.toBe('ok');
    expect(calls).toBe(3);
    let always = 0;
    await expect(withAttempts(async () => { always += 1; throw new Error(`down ${always}`); }, 3, 0)).rejects.toThrow('down 3');
    expect(always).toBe(3);
  });

  it('does not retry a refusal the driver made on purpose', async () => {
    let calls = 0;
    await expect(withAttempts(async () => { calls += 1; throw new RefusedToSign('no'); }, 3, 0)).rejects.toThrow(RefusedToSign);
    expect(calls).toBe(1);
  });
});

describe('the driver reads which screen the popup is on from its title', () => {
  it.each([
    ['Verify your identity', 'identity'],
    ['Verify your identity with Didit', 'waiting'],
    ['Checking your identity', 'waiting'],
    ['Verification refused', 'refused'],
    ['How much would you like to deposit?', 'amount'],
    ['Something else entirely', 'other'],
  ])('"%s" is the %s screen', (title, screen) => {
    expect(screenFromTitle(title)).toBe(screen);
  });
});
