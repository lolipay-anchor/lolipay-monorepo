import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, existsSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { Address, Keypair, StellarToml, Transaction, WebAuth, scValToNative } from '@stellar/stellar-sdk';
import { refundOpensAt } from '../order/dispute.util';
import { baseUnitsToUsdcString, fiatDigits, fiatInputAccepted, FIAT_INPUT_REFUSAL, quoteUsdcForFiat } from '../money/money';
import { Server } from '@stellar/stellar-sdk/rpc';

export const MAX_DEMO_FEE_STROOPS = 10_000_000n;
export const MAX_DEMO_USDC_STROOPS = 1_000_000_000n;
export const MIN_PLAUSIBLE_IDR_PER_USDC = 10_000n;
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

export function sep53Signature(kp: Keypair, nonce: string): string {
  const payload = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf8'),
    Buffer.from(nonce, 'utf8'),
  ]);
  return Buffer.from(kp.sign(createHash('sha256').update(payload).digest())).toString('base64');
}

export function assertTestnet(passphrase: string): void {
  if (passphrase !== TESTNET_PASSPHRASE) {
    throw new Error(`refusing to sign for network "${passphrase}"; this driver signs only for testnet`);
  }
}

export function readChallenge(
  xdr: string,
  serverSigningKey: string,
  homeDomain: string,
  webAuthDomain: string,
  clientPub: string,
): Transaction {
  const read = WebAuth.readChallengeTx(xdr, serverSigningKey, TESTNET_PASSPHRASE, homeDomain, webAuthDomain);
  if (read.clientAccountID !== clientPub) {
    throw new Error(`challenge names ${read.clientAccountID}, not the account being authenticated`);
  }
  return read.tx as Transaction;
}

export function signSep10Challenge(
  xdr: string,
  kp: Keypair,
  serverSigningKey: string,
  homeDomain: string,
  webAuthDomain: string,
): string {
  const tx = readChallenge(xdr, serverSigningKey, homeDomain, webAuthDomain, kp.publicKey());
  tx.sign(kp);
  return tx.toXdr();
}

export type EscrowFlow = 0 | 1;

export interface EscrowCallExpectation {
  tradeIdHex?: string;
  flow?: EscrowFlow;
  provider?: string;
  recipient?: string;
  confirmer?: string;
  lpWallet?: string;
  maxUsdcStroops?: bigint;
  usdcStroops?: bigint;
  fiatAmount?: bigint;
  fiatCurrency?: string;
  lpFeeBps?: number;
  payDeadline?: bigint;
  confirmDeadline?: bigint;
  disputeDeadline?: bigint;
}

const CREATE_TRADE_PINS = Object.keys({
  tradeIdHex: 1,
  flow: 1,
  provider: 1,
  recipient: 1,
  confirmer: 1,
  lpWallet: 1,
  usdcStroops: 1,
  maxUsdcStroops: 1,
  fiatAmount: 1,
  fiatCurrency: 1,
  lpFeeBps: 1,
  payDeadline: 1,
  confirmDeadline: 1,
  disputeDeadline: 1,
} satisfies Record<keyof EscrowCallExpectation, 1>) as (keyof EscrowCallExpectation)[];

function pinnedAmounts(order: FundableOrder, demoIdr: string, flow: 'TOP_UP' | 'WITHDRAW') {
  const fiatAmount = BigInt(demoIdrDigits(demoIdr));
  if (fiatAmount <= 0n) throw new Error(`demo amount "${demoIdr}" carries no rupiah digits; refusing to pin a zero fiat amount`);
  if (BigInt(order.fiat_amount) !== fiatAmount) {
    throw new Error(`assignment ${order.id} quotes fiat_amount ${order.fiat_amount}, not the ${demoIdr} the driver asked for`);
  }
  if (order.fiat_currency !== 'IDR') throw new Error(`assignment ${order.id} quotes fiat_currency ${order.fiat_currency}, not the IDR this driver funds`);
  if (order.flow !== flow) throw new Error(`assignment ${order.id} is a ${order.flow} order, not the ${flow} this leg signs`);
  return fiatAmount;
}

export function createWithdrawExpectation(order: FundableOrder, lp: string, demo: string, demoIdr: string): Required<EscrowCallExpectation> {
  const fiatAmount = pinnedAmounts(order, demoIdr, 'WITHDRAW');
  return {
    tradeIdHex: order.trade_id,
    flow: 1,
    provider: demo,
    recipient: lp,
    confirmer: demo,
    lpWallet: lp,
    usdcStroops: BigInt(order.usdc_amount),
    maxUsdcStroops: MAX_DEMO_USDC_STROOPS,
    fiatAmount,
    fiatCurrency: 'IDR',
    lpFeeBps: order.lp_fee_bps,
    payDeadline: BigInt(order.pay_deadline),
    confirmDeadline: BigInt(order.confirm_deadline),
    disputeDeadline: BigInt(order.dispute_deadline),
  };
}

export function createTradeExpectation(order: FundableOrder, lp: string, demo: string, demoIdr: string): Required<EscrowCallExpectation> {
  const fiatAmount = pinnedAmounts(order, demoIdr, 'TOP_UP');
  return {
    tradeIdHex: order.trade_id,
    flow: 0,
    provider: lp,
    recipient: demo,
    confirmer: lp,
    lpWallet: lp,
    usdcStroops: BigInt(order.usdc_amount),
    maxUsdcStroops: MAX_DEMO_USDC_STROOPS,
    fiatAmount,
    fiatCurrency: 'IDR',
    lpFeeBps: order.lp_fee_bps,
    payDeadline: BigInt(order.pay_deadline),
    confirmDeadline: BigInt(order.confirm_deadline),
    disputeDeadline: BigInt(order.dispute_deadline),
  };
}

export function assertEscrowCall(
  tx: Transaction,
  signer: string,
  contractId: string,
  fn: string,
  expect: EscrowCallExpectation = {},
): string {
  if (tx.source !== signer) throw new Error(`transaction source ${tx.source} is not the signer ${signer}`);
  if (BigInt(tx.fee) > MAX_DEMO_FEE_STROOPS) throw new Error(`transaction fee ${tx.fee} stroops is above the demo ceiling of ${MAX_DEMO_FEE_STROOPS}`);
  if (tx.operations.length !== 1) throw new Error(`expected exactly 1 operation, got ${tx.operations.length}`);
  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction') throw new Error(`expected an invokeHostFunction operation, got "${op.type}"`);
  if (op.func.type !== 'hostFunctionTypeInvokeContract') throw new Error('expected the host function to invoke a contract');
  const call = op.func.invokeContract;
  const target = Address.fromScAddress(call.contractAddress).toString();
  if (target !== contractId) throw new Error(`expected contract ${contractId}, got ${target}`);
  const name = call.functionName.toString();
  if (name !== fn) throw new Error(`expected function "${fn}", got "${name}"`);
  const args = call.args;
  if (args.length < 1) throw new Error(`${fn} carries no trade id`);
  if (args[0].type !== 'scvBytes') throw new Error(`${fn} trade id is ${args[0].type}, not scvBytes`);
  const rawTradeId = scValToNative(args[0]);
  if (rawTradeId.length !== 32) throw new Error(`${fn} trade id is not 32 bytes`);
  const tradeIdHex = Buffer.from(rawTradeId).toString('hex');
  if (expect.tradeIdHex === undefined) throw new Error(`${fn} expectation carries no tradeIdHex; refusing to sign a call the guard cannot pin to its trade`);
  if (tradeIdHex !== expect.tradeIdHex) throw new Error(`${fn} names trade ${tradeIdHex}, not ${expect.tradeIdHex}`);
  switch (fn) {
    case 'create_trade': {
        if (args.length !== 15) throw new Error(`create_trade carries ${args.length} arguments, expected 15`);
        const unpinned = CREATE_TRADE_PINS.filter((k) => expect[k] === undefined);
        if (unpinned.length > 0) throw new Error(`create_trade expectation carries no ${unpinned.join(', ')}; refusing to sign with a pin the guard does not hold`);
        const pins = expect as Required<EscrowCallExpectation>;
        const provider = Address.fromScVal(args[1]).toString();
        const recipient = Address.fromScVal(args[2]).toString();
        const confirmer = Address.fromScVal(args[3]).toString();
        const amountArg = args[4];
        if (amountArg.type !== 'scvI128') throw new Error(`create_trade amount is ${amountArg.type}, not scvI128`);
        const usdcStroops = scValToNative(amountArg) as bigint;
        if (usdcStroops <= 0n) throw new Error(`create_trade amount ${usdcStroops} is not positive`);
        const lpWallet = Address.fromScVal(args[11]).toString();
        const flowArg = args[7];
        if (flowArg.type !== 'scvU32' || scValToNative(flowArg) !== pins.flow) {
          throw new Error(`create_trade flow is not the ${pins.flow === 0 ? 'deposit' : 'withdrawal'} discriminant (u32 ${pins.flow}) this leg signs`);
        }
        if (provider !== pins.provider) throw new Error(`create_trade names provider ${provider}, not ${pins.provider}`);
        if (recipient !== pins.recipient) throw new Error(`create_trade names recipient ${recipient}, not ${pins.recipient}`);
        if (confirmer !== pins.confirmer) throw new Error(`create_trade names confirmer ${confirmer}, not ${pins.confirmer}`);
        if (lpWallet !== pins.lpWallet) throw new Error(`create_trade pays the LP fee to ${lpWallet}, not ${pins.lpWallet}`);
        if (usdcStroops > pins.maxUsdcStroops) {
          throw new Error(`create_trade escrows ${usdcStroops} stroops, above the demo ceiling of ${pins.maxUsdcStroops}`);
        }
        if (usdcStroops !== pins.usdcStroops) {
          throw new Error(`create_trade escrows ${usdcStroops} stroops, not the ${pins.usdcStroops} the assignment quoted`);
        }
        if (usdcStroops * MIN_PLAUSIBLE_IDR_PER_USDC > pins.fiatAmount * 10_000_000n) {
          throw new Error(`create_trade escrows ${usdcStroops} stroops against ${pins.fiatAmount} IDR, below ${MIN_PLAUSIBLE_IDR_PER_USDC} IDR per USDC`);
        }
        const fiatAmountArg = args[5];
        if (fiatAmountArg.type !== 'scvI128') throw new Error(`create_trade fiat amount is ${fiatAmountArg.type}, not scvI128`);
        if (scValToNative(fiatAmountArg) !== pins.fiatAmount) {
          throw new Error(`create_trade fiat_amount ${scValToNative(fiatAmountArg)} is not the ${pins.fiatAmount} the assignment quoted`);
        }
        const currencyArg = args[6];
        if (currencyArg.type !== 'scvSymbol') throw new Error(`create_trade fiat currency is ${currencyArg.type}, not scvSymbol`);
        if (scValToNative(currencyArg) !== pins.fiatCurrency) {
          throw new Error(`create_trade fiat_currency ${scValToNative(currencyArg)} is not the ${pins.fiatCurrency} the assignment quoted`);
        }
        const lpFeeArg = args[9];
        if (lpFeeArg.type !== 'scvU32') throw new Error(`create_trade lp fee is ${lpFeeArg.type}, not scvU32`);
        if (scValToNative(lpFeeArg) !== pins.lpFeeBps) {
          throw new Error(`create_trade lp_fee_bps ${scValToNative(lpFeeArg)} is not the ${pins.lpFeeBps} the assignment quoted`);
        }
        const payDeadline = args[12];
        const confirmDeadline = args[13];
        const disputeDeadline = args[14];
        if (payDeadline.type !== 'scvU64' || confirmDeadline.type !== 'scvU64' || disputeDeadline.type !== 'scvU64') {
          throw new Error('create_trade deadlines are not u64');
        }
        if (scValToNative(payDeadline) !== pins.payDeadline) {
          throw new Error(`create_trade pay_deadline ${scValToNative(payDeadline)} is not the ${pins.payDeadline} the assignment quoted`);
        }
        if (scValToNative(confirmDeadline) !== pins.confirmDeadline) {
          throw new Error(`create_trade confirm_deadline ${scValToNative(confirmDeadline)} is not the ${pins.confirmDeadline} the assignment quoted`);
        }
        if (scValToNative(disputeDeadline) !== pins.disputeDeadline) {
          throw new Error(`create_trade dispute_deadline ${scValToNative(disputeDeadline)} is not the ${pins.disputeDeadline} the assignment quoted`);
        }
      break;
    }
    case 'mark_fiat_paid': {
        if (args.length !== 2) throw new Error(`mark_fiat_paid carries ${args.length} arguments, expected 2`);
        const caller = Address.fromScVal(args[1]).toString();
        if (caller !== signer) throw new Error(`mark_fiat_paid names caller ${caller}, not the signer ${signer}`);
      break;
    }
    case 'confirm_and_release': {
      if (args.length !== 1) throw new Error(`confirm_and_release carries ${args.length} arguments, expected 1`);
      break;
    }
    default:
      throw new Error(`${fn} is not a call this driver signs`);
  }
  return tradeIdHex;
}

export interface AssignmentOrder {
  id: string;
  status: string;
  flow?: string | null;
  trade_id?: string | null;
  usdc_amount?: string | null;
  fiat_amount?: string | null;
  fiat_currency?: string | null;
  lp_fee_bps?: number | null;
  pay_deadline?: number | null;
  confirm_deadline?: number | null;
  dispute_deadline?: number | null;
  user_address?: string | null;
  created_at: string;
}

export type FundableOrder = AssignmentOrder & {
  trade_id: string;
  flow: string;
  usdc_amount: string;
  fiat_amount: string;
  fiat_currency: string;
  lp_fee_bps: number;
  pay_deadline: number;
  confirm_deadline: number;
  dispute_deadline: number;
};

export function pickFreshOrder(orders: AssignmentOrder[], userPub: string, notBeforeMs: number): FundableOrder {
  const mine = orders.filter(
    (o) => o.user_address === userPub && o.status === 'MATCHED' && Date.parse(o.created_at) >= notBeforeMs,
  );
  if (mine.length !== 1) {
    throw new Error(`expected exactly one fresh MATCHED order for ${userPub}, found ${mine.length}`);
  }
  const fresh = mine[0];
  const missing = (['trade_id', 'usdc_amount', 'fiat_amount', 'fiat_currency', 'lp_fee_bps', 'pay_deadline', 'confirm_deadline', 'dispute_deadline', 'flow'] as const).filter(
    (k) => fresh[k] == null || fresh[k] === '',
  );
  if (missing.length > 0) {
    throw new Error(`assignment ${fresh.id} carries no ${missing.join(', ')}; refusing to sign a create_trade the driver cannot check`);
  }
  return fresh as FundableOrder;
}

export function assembleSepConfig(input: {
  secret: string;
  depositPending: { id: string };
  depositCompleted: { id: string; stellar_transaction_id: string };
  withdrawCompleted?: { id: string; stellar_transaction_id: string };
}) {
  return {
    '24': {
      account: { secretKey: input.secret },
      depositPendingTransaction: { id: input.depositPending.id, status: 'pending_user_transfer_start' },
      depositCompletedTransaction: { ...input.depositCompleted, status: 'completed' },
      ...(input.withdrawCompleted ? { withdrawCompletedTransaction: { ...input.withdrawCompleted, status: 'completed' } } : {}),
    },
  };
}

export function expectedSep24Record(flow: 'TOP_UP' | 'WITHDRAW', usdcStroops: string, demoIdrDigitsValue: string, usdcIssuer: string): { amountIn: string; asset: string } {
  return flow === 'WITHDRAW'
    ? { amountIn: baseUnitsToUsdcString(BigInt(usdcStroops)), asset: `stellar:USDC:${usdcIssuer}` }
    : { amountIn: demoIdrDigitsValue, asset: 'iso4217:IDR' };
}

export function usdcNeededFor(fiatDigitsValue: string, displayIdrPerUsdc: string): bigint {
  const atDisplay = quoteUsdcForFiat(BigInt(fiatDigitsValue), displayIdrPerUsdc, 0, true);
  return (atDisplay * 110n + 99n) / 100n;
}

export function usdcBalanceOf(balances: Array<{ asset_code?: string; asset_issuer?: string; balance: string }>, issuer: string): bigint {
  const line = balances.find((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer);
  if (!line) return 0n;
  const [whole, frac = ''] = line.balance.split('.');
  return BigInt(whole) * 10_000_000n + BigInt((frac + '0000000').slice(0, 7));
}

const API = process.env.SEP24_API ?? 'https://api.lolipay.app';
const HOME_DOMAIN = process.env.SEP24_HOME_DOMAIN ?? 'lolipay.app';
const DEMO_IDR = process.env.SEP24_DEMO_IDR ?? '200000';
const DEMO_WITHDRAW_IDR = process.env.SEP24_DEMO_WITHDRAW_IDR ?? '150000';
const DEMO_PAYOUT_ACCOUNT = process.env.SEP24_DEMO_PAYOUT_ACCOUNT ?? 'BNI 1112223334 SEP24 DEMO';
const HORIZON_URL = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
export const demoIdrDigits = (raw: string) => {
  if (!fiatInputAccepted(raw) || fiatDigits(raw).length > 18) throw new Error(`"${raw}" is refused: ${FIAT_INPUT_REFUSAL}`);
  return String(BigInt(fiatDigits(raw)));
};
const demoIdrReadable = (raw: string) => fiatInputAccepted(raw) && fiatDigits(raw).length <= 18;
export const DEMO_IDR_DIGITS = demoIdrReadable(DEMO_IDR) ? demoIdrDigits(DEMO_IDR) : '0';
export const DEMO_WITHDRAW_IDR_DIGITS = demoIdrReadable(DEMO_WITHDRAW_IDR) ? demoIdrDigits(DEMO_WITHDRAW_IDR) : '0';
const PROOF_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const RPC_URL = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const HEARTBEAT_MS = 30_000;
const POLL_MS = 5_000;
const POLL_LIMIT_MS = 5 * 60_000;
const TOKEN_REFRESH_MS = 10 * 60_000;
const CONFIG_PATH = resolve(__dirname, '../../anchor-tests/sep-config.local.json');

function identity(name: string): Keypair {
  const secret = execFileSync('stellar', ['keys', 'secret', name], { encoding: 'utf8' }).trim();
  return Keypair.fromSecret(secret);
}

function plain(html: string): string {
  const p = html.match(/<p>([^<]*)<\/p>/);
  return (p ? p[1] : html).slice(0, 300);
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${plain(text)}`);
  return text ? (JSON.parse(text) as T) : (null as T);
}

function tokenSource(mint: () => Promise<string>): () => Promise<string> {
  let value = '';
  let at = 0;
  return async () => {
    if (!value || Date.now() - at > TOKEN_REFRESH_MS) {
      value = await mint();
      at = Date.now();
    }
    return value;
  };
}

async function sessionJwt(kp: Keypair): Promise<string> {
  const challenge = await json<{ nonce: string }>(
    await fetch(`${API}/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: kp.publicKey() }),
    }),
    'auth/challenge',
  );
  const verified = await json<{ jwt: string }>(
    await fetch(`${API}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        address: kp.publicKey(),
        nonce: challenge.nonce,
        signature: sep53Signature(kp, challenge.nonce),
      }),
    }),
    'auth/verify',
  );
  return verified.jwt;
}

async function anchorIdentity(): Promise<{ signingKey: string; webAuthDomain: string }> {
  const toml = (await StellarToml.Resolver.resolve(HOME_DOMAIN, { timeout: 15000, allowedRedirects: 3 })) as Record<string, string>;
  if (!toml.SIGNING_KEY || !toml.WEB_AUTH_ENDPOINT) {
    throw new Error(`${HOME_DOMAIN}'s stellar.toml lacks SIGNING_KEY or WEB_AUTH_ENDPOINT`);
  }
  return { signingKey: toml.SIGNING_KEY, webAuthDomain: new URL(toml.WEB_AUTH_ENDPOINT).host };
}

async function sep10Jwt(kp: Keypair, anchor: { signingKey: string; webAuthDomain: string }): Promise<string> {
  const challenge = await json<{ transaction: string; network_passphrase: string }>(
    await fetch(`${API}/auth?account=${kp.publicKey()}&home_domain=${HOME_DOMAIN}`),
    'sep10 challenge',
  );
  assertTestnet(challenge.network_passphrase);
  const signed = signSep10Challenge(challenge.transaction, kp, anchor.signingKey, HOME_DOMAIN, anchor.webAuthDomain);
  const issued = await json<{ token: string }>(
    await fetch(`${API}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transaction: signed }),
    }),
    'sep10 token',
  );
  return issued.token;
}

const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

async function readyLp(lpJwt: () => Promise<string>, lpPub: string): Promise<() => void> {
  const me = await json<{ status: string; online: boolean; paymentMethods: Array<{ rail: string; currency: string; active: boolean }> } | null>(
    await fetch(`${API}/lp/me`, { headers: bearer(await lpJwt()) }),
    'lp/me',
  );
  if (!me) throw new Error(`${lpPub} is not registered as a provider`);
  if (me.status !== 'APPROVED') throw new Error(`provider ${lpPub} is ${me.status}, not APPROVED`);
  const eligibility = await json<{ eligible: boolean; staked: string }>(
    await fetch(`${API}/lp/eligibility`, { headers: bearer(await lpJwt()) }),
    'lp/eligibility',
  );
  const missing: string[] = [];
  if (!eligibility.eligible) missing.push(`provider is not eligible (staked ${Number(eligibility.staked) / 1e7} USDC)`);
  if (!me.paymentMethods.some((m) => m.rail === 'BANK' && m.currency === 'IDR' && m.active)) {
    missing.push('provider has no active BANK/IDR payment method');
  }
  if (missing.length) throw new Error(`the provider cannot be matched:\n  ${missing.join('\n  ')}`);
  if (!me.online) {
    await json(
      await fetch(`${API}/lp/availability`, {
        method: 'POST',
        headers: { ...bearer(await lpJwt()), 'content-type': 'application/json' },
        body: JSON.stringify({ available: true }),
      }),
      'lp/availability',
    );
  }
  const beat = async () => {
    try {
      const res = await fetch(`${API}/lp/heartbeat`, { method: 'POST', headers: bearer(await lpJwt()) });
      if (!res.ok) console.error(`heartbeat: HTTP ${res.status}`);
    } catch (err) {
      console.error(`heartbeat: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  await beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

interface Session {
  id: string;
  cookie: string;
}

async function openInteractive(kind: 'deposit' | 'withdraw', demoSep10: () => Promise<string>): Promise<Session> {
  const opened = await json<{ id: string; url: string }>(
    await fetch(`${API}/sep24/transactions/${kind}/interactive`, {
      method: 'POST',
      headers: { ...bearer(await demoSep10()), 'content-type': 'application/json' },
      body: JSON.stringify({ asset_code: 'USDC' }),
    }),
    `${kind}/interactive`,
  );
  const hop = await fetch(opened.url, { redirect: 'manual' });
  const setCookie = hop.headers.get('set-cookie') ?? '';
  if (hop.status !== 302 || !setCookie) throw new Error(`interactive link did not set a session: HTTP ${hop.status}`);
  return { id: opened.id, cookie: setCookie.split(';')[0] };
}

type Screen = 'identity' | 'waiting' | 'amount' | 'refused' | 'other';

async function screenOf(session: Session): Promise<{ screen: Screen; vendorUrl?: string }> {
  const res = await fetch(`${API}/sep24/interactive/${session.id}`, { headers: { cookie: session.cookie } });
  const refreshed = res.headers.get('set-cookie');
  if (refreshed) session.cookie = refreshed.split(';')[0];
  const page = await res.text();
  if (!res.ok) throw new Error(`interactive page: HTTP ${res.status} ${plain(page)}`);
  const title = (page.match(/<h1>([^<]*)<\/h1>/) ?? [])[1] ?? '';
  const vendorUrl = (page.match(/href="(https:\/\/verify\.didit\.me\/[^"]+)"/) ?? [])[1];
  if (/verify your identity/i.test(title)) return { screen: 'identity', vendorUrl };
  if (/checking your identity/i.test(title)) return { screen: 'waiting', vendorUrl };
  if (/verification refused/i.test(title)) return { screen: 'refused' };
  if (/how much would you like/i.test(title)) return { screen: 'amount' };
  return { screen: 'other' };
}

async function postForm(session: Session, step: string, fields: Record<string, string>): Promise<void> {
  const res = await fetch(`${API}/sep24/interactive/${session.id}/${step}`, {
    method: 'POST',
    headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  if (res.status === 302) return;
  const body = plain(await res.text());
  if (step === 'amount' && (res.status === 503 || res.status === 400)) {
    throw new Error(
      `${step}: HTTP ${res.status} — ${body}\n  (503 usually means no provider is matchable right now: heartbeat, stake exposure or an earlier stranded order; 400 usually means the demo account's daily limit or a trustline)`,
    );
  }
  throw new Error(`${step}: HTTP ${res.status} ${body}`);
}

async function assertScreened(session: Session): Promise<void> {
  let { screen, vendorUrl } = await screenOf(session);
  if (screen === 'identity') {
    await postForm(session, 'identity', {
      first_name: 'Budi',
      last_name: 'Santoso',
      email_address: 'budi.santoso@example.com',
      id_type: 'id_card',
      id_country_code: 'IDN',
    });
    ({ screen, vendorUrl } = await screenOf(session));
  }
  if (screen === 'waiting') {
    const until = Date.now() + 60_000;
    while (Date.now() < until && screen === 'waiting') {
      await new Promise((r) => setTimeout(r, 10_000));
      ({ screen, vendorUrl } = await screenOf(session));
    }
  }
  if (screen === 'refused') {
    throw new Error("The demo account's identity was REFUSED by the provider. That is terminal for this person; use a fresh identity.");
  }
  if (screen !== 'amount') {
    throw new Error(
      [
        'The demo account has no screened identity yet.',
        vendorUrl
          ? `Complete the verification at:\n  ${vendorUrl}\nthen re-run. (Whoever opens that link can submit documents into the demo identity; do not archive it.)`
          : `The interactive page shows "${screen}"; open the deposit in a browser to see why, then re-run.`,
      ].join('\n'),
    );
  }
}

async function freshOrderFor(lpJwt: () => Promise<string>, userPub: string, notBeforeMs: number): Promise<FundableOrder> {
  const rows = await json<Array<{ order: AssignmentOrder }>>(
    await fetch(`${API}/lp/assignments`, { headers: bearer(await lpJwt()) }),
    'lp/assignments',
  );
  return pickFreshOrder(rows.map((r) => r.order), userPub, notBeforeMs);
}

async function xdrFor(jwt: () => Promise<string>, orderId: string, leg: string): Promise<{ xdr: string; networkPassphrase: string }> {
  return json(await fetch(`${API}/orders/${orderId}/tx/${leg}`, { headers: bearer(await jwt()) }), `tx/${leg}`);
}

async function popupXdrFor(session: Session, leg: 'fund-tx' | 'release-tx'): Promise<{ xdr: string; networkPassphrase: string }> {
  return json(await fetch(`${API}/sep24/interactive/${session.id}/${leg}`, { headers: { cookie: session.cookie } }), leg);
}

async function uploadProof(lpJwt: () => Promise<string>, orderId: string): Promise<void> {
  const form = new FormData();
  form.append('file', new Blob([PROOF_PNG], { type: 'image/png' }), 'proof.png');
  await json(await fetch(`${API}/orders/${orderId}/proof`, { method: 'POST', headers: bearer(await lpJwt()), body: form }), 'orders/proof');
}

async function usdcHeldBy(account: string, issuer: string): Promise<bigint> {
  const res = await fetch(`${HORIZON_URL}/accounts/${account}`);
  const body = await json<{ balances: Array<{ asset_code?: string; asset_issuer?: string; balance: string }> }>(res, 'horizon/accounts');
  return usdcBalanceOf(body.balances, issuer);
}

async function signAndSubmit(
  kp: Keypair,
  built: { xdr: string; networkPassphrase: string },
  contractId: string,
  fn: string,
  expect: EscrowCallExpectation & { tradeIdHex: string },
): Promise<{ hash: string; tradeIdHex: string }> {
  assertTestnet(built.networkPassphrase);
  const tx = new Transaction(built.xdr, TESTNET_PASSPHRASE);
  const tradeIdHex = assertEscrowCall(tx, kp.publicKey(), contractId, fn, expect);
  tx.sign(kp);
  const server = new Server(RPC_URL);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') {
    throw new Error(`submit ${sent.status}: ${JSON.stringify(sent.errorResult ?? null)}`);
  }
  const until = Date.now() + POLL_LIMIT_MS;
  while (Date.now() < until) {
    const got = await server.getTransaction(sent.hash);
    if (got.status === 'SUCCESS') return { hash: sent.hash, tradeIdHex };
    if (got.status === 'FAILED') throw new Error(`transaction ${sent.hash} failed on chain`);
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`transaction ${sent.hash} not confirmed within ${POLL_LIMIT_MS / 1000}s`);
}

async function waitForSep24(
  demoSep10: () => Promise<string>,
  id: string,
  status: string,
  record: { amountIn: string; asset: string },
): Promise<{ status: string; stellar_transaction_id: string | null; amount_in: string | null; amount_in_asset: string | null }> {
  const until = Date.now() + POLL_LIMIT_MS;
  while (Date.now() < until) {
    const { transaction } = await json<{
      transaction: { status: string; stellar_transaction_id: string | null; amount_in: string | null; amount_in_asset: string | null };
    }>(
      await fetch(`${API}/sep24/transaction?id=${id}`, { headers: bearer(await demoSep10()) }),
      'sep24/transaction',
    );
    if (transaction.status === status) {
      if (transaction.amount_in !== record.amountIn) throw new Error(`transaction ${id} records amount_in ${transaction.amount_in}, not the ${record.amountIn} the driver asked for`);
      if (transaction.amount_in_asset !== record.asset) throw new Error(`transaction ${id} records amount_in_asset ${transaction.amount_in_asset}, not ${record.asset}`);
      return transaction;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`transaction ${id} did not reach ${status} within ${POLL_LIMIT_MS / 1000}s`);
}

interface Actors {
  demo: Keypair;
  lp: Keypair;
  demoJwt: () => Promise<string>;
  lpJwt: () => Promise<string>;
  demoSep10: () => Promise<string>;
  escrow: string;
  usdcIssuer: string;
}

const DEPOSIT_RECORD = { amountIn: DEMO_IDR_DIGITS, asset: 'iso4217:IDR' };

async function settledHash(a: Actors, id: string, record: { amountIn: string; asset: string }): Promise<string> {
  let done = await waitForSep24(a.demoSep10, id, 'completed', record);
  for (let i = 0; i < 6 && !done.stellar_transaction_id; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    done = await waitForSep24(a.demoSep10, id, 'completed', record);
  }
  if (!done.stellar_transaction_id) throw new Error(`transaction ${id} is completed but carries no stellar_transaction_id`);
  return done.stellar_transaction_id;
}

async function withdrawToCompleted(a: Actors): Promise<{ id: string; hash: string }> {
  const rate = await json<{ rate: string }>(await fetch(`${API}/rate?fiat=IDR`), 'rate');
  const needed = usdcNeededFor(DEMO_WITHDRAW_IDR_DIGITS, rate.rate);
  const held = await usdcHeldBy(a.demo.publicKey(), a.usdcIssuer);
  if (held < needed) {
    throw new Error(`the demo account holds ${baseUnitsToUsdcString(held)} USDC, below the ${baseUnitsToUsdcString(needed)} a ${DEMO_WITHDRAW_IDR} IDR withdrawal needs with a ten percent margin at ${rate.rate} IDR per USDC; send it USDC or lower SEP24_DEMO_WITHDRAW_IDR`);
  }
  const session = await openInteractive('withdraw', a.demoSep10);
  await assertScreened(session);
  const t0 = Date.now() - 5_000;
  await postForm(session, 'amount', { fiat_amount: DEMO_WITHDRAW_IDR, user_payment_method: DEMO_PAYOUT_ACCOUNT });
  const rows = await json<Array<{ order: AssignmentOrder; require_proof: boolean }>>(
    await fetch(`${API}/lp/assignments`, { headers: bearer(await a.lpJwt()) }),
    'lp/assignments',
  );
  const order = pickFreshOrder(rows.map((r) => r.order), a.demo.publicKey(), t0);
  const requireProof = rows.some((r) => r.order.id === order.id && r.require_proof);
  console.log(`withdrawal ${session.id}: order ${order.id} ${order.status}, created ${order.created_at}`);
  if (held < BigInt(order.usdc_amount)) {
    throw new Error(`the demo account holds ${baseUnitsToUsdcString(held)} USDC but order ${order.id} escrows ${baseUnitsToUsdcString(BigInt(order.usdc_amount))}; the order expires on its own, send the demo account USDC and re-run`);
  }
  const record = expectedSep24Record('WITHDRAW', order.usdc_amount, DEMO_WITHDRAW_IDR_DIGITS, a.usdcIssuer);
  const funded = await signAndSubmit(
    a.demo,
    await popupXdrFor(session, 'fund-tx'),
    a.escrow,
    'create_trade',
    createWithdrawExpectation(order, a.lp.publicKey(), a.demo.publicKey(), DEMO_WITHDRAW_IDR),
  );
  console.log(`  escrow funded by the demo account: ${funded.hash} (trade ${funded.tradeIdHex})`);
  await waitForSep24(a.demoSep10, session.id, 'pending_anchor', record);
  if (requireProof) {
    await uploadProof(a.lpJwt, order.id);
    console.log('  proof of the rupiah transfer uploaded by the provider');
  }
  const paid = await signAndSubmit(a.lp, await xdrFor(a.lpJwt, order.id, 'mark-paid'), a.escrow, 'mark_fiat_paid', { tradeIdHex: funded.tradeIdHex });
  console.log(`  rupiah marked paid by the provider: ${paid.hash}`);
  await waitForSep24(a.demoSep10, session.id, 'pending_user', record);
  await screenOf(session);
  const released = (await signAndSubmit(a.demo, await popupXdrFor(session, 'release-tx'), a.escrow, 'confirm_and_release', { tradeIdHex: funded.tradeIdHex })).hash;
  console.log(`  escrow released by the demo account: ${released}`);
  const hash = await settledHash(a, session.id, record);
  if (hash !== released) throw new Error(`recorded hash ${hash} is not the release transaction ${released}`);
  return { id: session.id, hash };
}

async function depositToFunded(a: Actors) {
  const session = await openInteractive('deposit', a.demoSep10);
  const { id } = session;
  await assertScreened(session);
  const t0 = Date.now() - 5_000;
  await postForm(session, 'amount', { fiat_amount: DEMO_IDR });
  const order = await freshOrderFor(a.lpJwt, a.demo.publicKey(), t0);
  console.log(`deposit ${id}: order ${order.id} ${order.status}, created ${order.created_at}`);
  const funded = await signAndSubmit(
    a.lp,
    await xdrFor(a.lpJwt, order.id, 'create-trade'),
    a.escrow,
    'create_trade',
    createTradeExpectation(order, a.lp.publicKey(), a.demo.publicKey(), DEMO_IDR),
  );
  console.log(`  escrow funded by the provider: ${funded.hash} (trade ${funded.tradeIdHex})`);
  await waitForSep24(a.demoSep10, id, 'pending_user_transfer_start', DEPOSIT_RECORD);
  const refundsAt = new Date(
    Number(refundOpensAt({ flow: 'TOP_UP', payDeadline: BigInt(order.pay_deadline), confirmDeadline: BigInt(order.confirm_deadline) })) * 1000,
  ).toISOString();
  return { id, orderId: order.id, refundsAt, tradeIdHex: funded.tradeIdHex };
}

function writeConfig(cfg: unknown): void {
  const tmp = `${CONFIG_PATH}.tmp`;
  if (existsSync(tmp)) unlinkSync(tmp);
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
  renameSync(tmp, CONFIG_PATH);
}

async function main(): Promise<void> {
  if (DEMO_IDR_DIGITS === '0') {
    throw new Error(
      demoIdrReadable(DEMO_IDR)
        ? `SEP24_DEMO_IDR "${DEMO_IDR}" is zero rupiah; name a positive amount`
        : `SEP24_DEMO_IDR "${DEMO_IDR}" is refused: ${FIAT_INPUT_REFUSAL}`,
    );
  }
  if (DEMO_WITHDRAW_IDR_DIGITS === '0') {
    throw new Error(
      demoIdrReadable(DEMO_WITHDRAW_IDR)
        ? `SEP24_DEMO_WITHDRAW_IDR "${DEMO_WITHDRAW_IDR}" is zero rupiah; name a positive amount`
        : `SEP24_DEMO_WITHDRAW_IDR "${DEMO_WITHDRAW_IDR}" is refused: ${FIAT_INPUT_REFUSAL}`,
    );
  }
  const escrow = process.env.ESCROW_CONTRACT_ID;
  if (!escrow) throw new Error('ESCROW_CONTRACT_ID is not set; the driver refuses to sign a call to an unnamed contract');
  const usdcIssuer = process.env.USDC_ASSET_ISSUER;
  if (!usdcIssuer || !/^G[A-Z2-7]{55}$/.test(usdcIssuer)) throw new Error('USDC_ASSET_ISSUER is not set to a G address; the driver cannot name the asset a withdrawal records');
  const demo = identity(process.env.SEP24_DEMO_IDENTITY ?? 'sep24-demo');
  const lp = identity(process.env.SEP24_LP_IDENTITY ?? 'e2e-provider');
  console.log(`demo account ${demo.publicKey()}`);
  console.log(`provider     ${lp.publicKey()}`);
  console.log(`escrow       ${escrow}`);

  const anchor = await anchorIdentity();
  const a: Actors = {
    demo,
    lp,
    escrow,
    usdcIssuer,
    demoJwt: tokenSource(() => sessionJwt(demo)),
    lpJwt: tokenSource(() => sessionJwt(lp)),
    demoSep10: tokenSource(() => sep10Jwt(demo, anchor)),
  };

  const stop = await readyLp(a.lpJwt, lp.publicKey());
  try {
    let withdrawal: { id: string; hash: string } | undefined;
    try {
      withdrawal = await withdrawToCompleted(a);
    } catch (err) {
      console.error(`withdrawal leg failed; the deposits still run and the config carries no withdrawal fixture. If the log above shows the escrow was funded, that withdrawal order is FUNDED on chain and holds provider capacity until its deadlines pass or a human settles it: ${err instanceof Error ? err.message : String(err)}`);
    }
    const first = await depositToFunded(a);
    const paid = await signAndSubmit(demo, await xdrFor(a.demoJwt, first.orderId, 'mark-paid'), escrow, 'mark_fiat_paid', {
      tradeIdHex: first.tradeIdHex,
    });
    console.log(`  rupiah marked paid by the depositor: ${paid.hash}`);
    const released = (
      await signAndSubmit(lp, await xdrFor(a.lpJwt, first.orderId, 'confirm-release'), escrow, 'confirm_and_release', {
        tradeIdHex: first.tradeIdHex,
      })
    ).hash;
    console.log(`  escrow released by the provider: ${released}`);
    const hash = await settledHash(a, first.id, DEPOSIT_RECORD);
    if (hash !== released) throw new Error(`recorded hash ${hash} is not the release transaction ${released}`);

    const second = await depositToFunded(a);
    const rotsAt = second.refundsAt;

    console.log('');
    if (withdrawal) console.log(`completed withdrawal ${withdrawal.id}  hash ${withdrawal.hash}`);
    else console.log('completed withdrawal —  (leg failed, see above; the suite will skip its two tests)');
    console.log(`completed deposit    ${first.id}  hash ${hash}`);
    console.log(`pending deposit      ${second.id}  refund window opens ${rotsAt} if it is still funded by then`);

    if (!first.id || !second.id || (withdrawal && !withdrawal.id)) throw new Error('a fixture id is empty; refusing to write the config');
    writeConfig(
      assembleSepConfig({
        secret: demo.secret(),
        depositPending: { id: second.id },
        depositCompleted: { id: first.id, stellar_transaction_id: hash },
        withdrawCompleted: withdrawal ? { id: withdrawal.id, stellar_transaction_id: withdrawal.hash } : undefined,
      }),
    );
    console.log(`wrote ${CONFIG_PATH} (mode 0600); run npm run anchor:test:sep24 before ${rotsAt}, while the pending deposit is still funded`);
  } finally {
    stop();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
