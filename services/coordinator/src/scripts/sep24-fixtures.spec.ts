import { Account, Address, Asset, Contract, Keypair, Networks, Operation, Transaction, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import {
  MAX_DEMO_FEE_STROOPS,
  MAX_DEMO_USDC_STROOPS,
  MIN_PLAUSIBLE_IDR_PER_USDC,
  TESTNET_PASSPHRASE,
  assembleSepConfig,
  createTradeExpectation,
  demoIdrDigits,
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
      tradeIdHex: TRADE, provider: lp, recipient: demo, confirmer: lp, lpWallet: lp, usdcStroops: 125_000_000n, maxUsdcStroops: 1_000_000_000n,
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
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), TRADE, nativeToScVal(0, { type: 'i32' })), lp, ESCROW, 'create_trade', want)).toThrow(/not the deposit discriminant/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), TRADE, u32(0), u64(PAY + 1n)), lp, ESCROW, 'create_trade', want)).toThrow(/pay_deadline .* the assignment quoted/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), TRADE, u32(0), u64(PAY), u64(CONFIRM - 1n)), lp, ESCROW, 'create_trade', want)).toThrow(/confirm_deadline .* the assignment quoted/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), TRADE, u32(0), u32(1_700_000_600)), lp, ESCROW, 'create_trade', want)).toThrow(/deadlines are not u64/);
    expect(() => assertEscrowCall(create(lp, demo, lp, i128(125_000_000n), TRADE, u32(0), u64(PAY), u32(1_700_003_600)), lp, ESCROW, 'create_trade', want)).toThrow(/deadlines are not u64/);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, payDeadline: undefined })).toThrow(/carries no payDeadline;/);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', { ...want, lpWallet: undefined, confirmDeadline: undefined })).toThrow(/carries no lpWallet, confirmDeadline;/);
    expect(() => assertEscrowCall(create(lp, demo), lp, ESCROW, 'create_trade', PIN)).toThrow(
      'carries no provider, recipient, confirmer, lpWallet, usdcStroops, maxUsdcStroops, fiatAmount, fiatCurrency, lpFeeBps, payDeadline, confirmDeadline, disputeDeadline;',
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
      id: 'new', status: 'MATCHED', user_address: me, created_at: '2026-09-03T05:00:10Z', trade_id: TRADE, usdc_amount: '125000000',
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
      id: 'o', status: 'MATCHED', created_at: '2026-09-03T05:00:10Z', trade_id: TRADE, usdc_amount: '125000000',
      fiat_amount: '200000', fiat_currency: 'IDR', lp_fee_bps: 20, pay_deadline: 1_700_000_600, confirm_deadline: 1_700_003_600, dispute_deadline: 1_700_090_000,
    };
    expect(createTradeExpectation(order, lp, demo, 'Rp 200.000')).toEqual({
      tradeIdHex: TRADE,
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
    expect(() => createTradeExpectation({ ...order, fiat_amount: '250000' }, lp, demo, '250,000')).toThrow(/without a comma/);
    expect(createTradeExpectation({ ...order, fiat_amount: '250000' }, lp, demo, '250.000').fiatAmount).toBe(250_000n);
    expect(() => createTradeExpectation({ ...order, fiat_amount: '0' }, lp, demo, 'abc')).toThrow(/carries no rupiah digits/);
    expect(() => createTradeExpectation({ ...order, fiat_currency: 'USD' }, lp, demo, '200000')).toThrow(/quotes fiat_currency USD, not the IDR/);
  });

  it('refuses a comma in the demo amount before anything is opened, with the same words the anchor would answer', () => {
    expect(() => demoIdrDigits('200,000')).toThrow(/without a comma/);
    expect(demoIdrDigits('200.000')).toBe('200000');
  });

  it('canonicalises the demo amount the way the record will echo it, so a leading zero cannot refuse an honest run', () => {
    expect(demoIdrDigits('0200000')).toBe('200000');
    expect(demoIdrDigits('Rp 200.000')).toBe('200000');
    expect(demoIdrDigits('abc')).toBe('0');
    expect(demoIdrDigits('')).toBe('0');
    const previous = process.env.SEP24_DEMO_IDR;
    process.env.SEP24_DEMO_IDR = 'Rp 0300.000';
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
    expect(JSON.stringify(cfg).split(secret).length - 1).toBe(1);
  });
});
