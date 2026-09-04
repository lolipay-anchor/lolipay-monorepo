import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, existsSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { Address, Keypair, StellarToml, Transaction, WebAuth, scValToNative } from '@stellar/stellar-sdk';
import { refundOpensAt } from '../order/dispute.util';
import { Server } from '@stellar/stellar-sdk/rpc';

export const MAX_DEMO_FEE_STROOPS = 10_000_000n;
export const MAX_DEMO_USDC_STROOPS = 1_000_000_000n;
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

export interface EscrowCallExpectation {
  tradeIdHex?: string;
  provider?: string;
  recipient?: string;
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
  provider: 1,
  recipient: 1,
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

export function createTradeExpectation(order: FundableOrder, lp: string, demo: string): Required<EscrowCallExpectation> {
  return {
    tradeIdHex: order.trade_id,
    provider: lp,
    recipient: demo,
    lpWallet: lp,
    usdcStroops: BigInt(order.usdc_amount),
    maxUsdcStroops: MAX_DEMO_USDC_STROOPS,
    fiatAmount: BigInt(DEMO_IDR.replace(/[^0-9]/g, '')),
    fiatCurrency: order.fiat_currency,
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
        if (unpinned.length > 0) throw new Error(`create_trade expectation carries no ${unpinned.join(', ')}; refusing to sign what the guard cannot pin`);
        const pins = expect as Required<EscrowCallExpectation>;
        const provider = Address.fromScVal(args[1]).toString();
        const recipient = Address.fromScVal(args[2]).toString();
        const amountArg = args[4];
        if (amountArg.type !== 'scvI128') throw new Error(`create_trade amount is ${amountArg.type}, not scvI128`);
        const usdcStroops = scValToNative(amountArg) as bigint;
        if (usdcStroops <= 0n) throw new Error(`create_trade amount ${usdcStroops} is not positive`);
        const lpWallet = Address.fromScVal(args[11]).toString();
        const flowArg = args[7];
        if (flowArg.type !== 'scvU32' || scValToNative(flowArg) !== 0) throw new Error('create_trade flow is not the deposit discriminant (u32 0), the only flow this driver funds');
        if (provider !== pins.provider) throw new Error(`create_trade names provider ${provider}, not ${pins.provider}`);
        if (recipient !== pins.recipient) throw new Error(`create_trade names recipient ${recipient}, not ${pins.recipient}`);
        if (lpWallet !== pins.lpWallet) throw new Error(`create_trade pays the LP fee to ${lpWallet}, not ${pins.lpWallet}`);
        if (usdcStroops > pins.maxUsdcStroops) {
          throw new Error(`create_trade escrows ${usdcStroops} stroops, above the demo ceiling of ${pins.maxUsdcStroops}`);
        }
        if (usdcStroops !== pins.usdcStroops) {
          throw new Error(`create_trade escrows ${usdcStroops} stroops, not the ${pins.usdcStroops} the assignment quoted`);
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
  const missing = (['trade_id', 'usdc_amount', 'fiat_amount', 'fiat_currency', 'lp_fee_bps', 'pay_deadline', 'confirm_deadline', 'dispute_deadline'] as const).filter(
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
}) {
  return {
    '24': {
      account: { secretKey: input.secret },
      depositPendingTransaction: { id: input.depositPending.id, status: 'pending_user_transfer_start' },
      depositCompletedTransaction: { ...input.depositCompleted, status: 'completed' },
    },
  };
}

const API = process.env.SEP24_API ?? 'https://api.lolipay.app';
const HOME_DOMAIN = process.env.SEP24_HOME_DOMAIN ?? 'lolipay.app';
const DEMO_IDR = process.env.SEP24_DEMO_IDR ?? '200000';
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

async function openDeposit(demoSep10: () => Promise<string>): Promise<{ id: string; cookie: string }> {
  const opened = await json<{ id: string; url: string }>(
    await fetch(`${API}/sep24/transactions/deposit/interactive`, {
      method: 'POST',
      headers: { ...bearer(await demoSep10()), 'content-type': 'application/json' },
      body: JSON.stringify({ asset_code: 'USDC' }),
    }),
    'deposit/interactive',
  );
  const hop = await fetch(opened.url, { redirect: 'manual' });
  const setCookie = hop.headers.get('set-cookie') ?? '';
  if (hop.status !== 302 || !setCookie) throw new Error(`interactive link did not set a session: HTTP ${hop.status}`);
  return { id: opened.id, cookie: setCookie.split(';')[0] };
}

type Screen = 'identity' | 'waiting' | 'amount' | 'refused' | 'other';

async function screenOf(id: string, cookie: string): Promise<{ screen: Screen; vendorUrl?: string }> {
  const res = await fetch(`${API}/sep24/interactive/${id}`, { headers: { cookie } });
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

async function postForm(id: string, step: string, cookie: string, fields: Record<string, string>): Promise<void> {
  const res = await fetch(`${API}/sep24/interactive/${id}/${step}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
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

async function assertScreened(id: string, cookie: string): Promise<void> {
  let { screen, vendorUrl } = await screenOf(id, cookie);
  if (screen === 'identity') {
    await postForm(id, 'identity', cookie, {
      first_name: 'Budi',
      last_name: 'Santoso',
      email_address: 'budi.santoso@example.com',
      id_type: 'id_card',
      id_country_code: 'IDN',
    });
    ({ screen, vendorUrl } = await screenOf(id, cookie));
  }
  if (screen === 'waiting') {
    const until = Date.now() + 60_000;
    while (Date.now() < until && screen === 'waiting') {
      await new Promise((r) => setTimeout(r, 10_000));
      ({ screen, vendorUrl } = await screenOf(id, cookie));
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

async function waitForSep24(demoSep10: () => Promise<string>, id: string, status: string): Promise<{ status: string; stellar_transaction_id: string | null }> {
  const until = Date.now() + POLL_LIMIT_MS;
  while (Date.now() < until) {
    const { transaction } = await json<{ transaction: { status: string; stellar_transaction_id: string | null } }>(
      await fetch(`${API}/sep24/transaction?id=${id}`, { headers: bearer(await demoSep10()) }),
      'sep24/transaction',
    );
    if (transaction.status === status) return transaction;
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
}

async function depositToFunded(a: Actors) {
  const { id, cookie } = await openDeposit(a.demoSep10);
  await assertScreened(id, cookie);
  const t0 = Date.now() - 5_000;
  await postForm(id, 'amount', cookie, { fiat_amount: DEMO_IDR });
  const order = await freshOrderFor(a.lpJwt, a.demo.publicKey(), t0);
  console.log(`deposit ${id}: order ${order.id} ${order.status}, created ${order.created_at}`);
  const funded = await signAndSubmit(
    a.lp,
    await xdrFor(a.lpJwt, order.id, 'create-trade'),
    a.escrow,
    'create_trade',
    createTradeExpectation(order, a.lp.publicKey(), a.demo.publicKey()),
  );
  console.log(`  escrow funded by the provider: ${funded.hash} (trade ${funded.tradeIdHex})`);
  await waitForSep24(a.demoSep10, id, 'pending_user_transfer_start');
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
  const escrow = process.env.ESCROW_CONTRACT_ID;
  if (!escrow) throw new Error('ESCROW_CONTRACT_ID is not set; the driver refuses to sign a call to an unnamed contract');
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
    demoJwt: tokenSource(() => sessionJwt(demo)),
    lpJwt: tokenSource(() => sessionJwt(lp)),
    demoSep10: tokenSource(() => sep10Jwt(demo, anchor)),
  };

  const stop = await readyLp(a.lpJwt, lp.publicKey());
  try {
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
    let done = await waitForSep24(a.demoSep10, first.id, 'completed');
    for (let i = 0; i < 6 && !done.stellar_transaction_id; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      done = await waitForSep24(a.demoSep10, first.id, 'completed');
    }
    const hash = done.stellar_transaction_id;
    if (!hash) throw new Error(`deposit ${first.id} is completed but carries no stellar_transaction_id`);
    if (hash !== released) throw new Error(`recorded hash ${hash} is not the release transaction ${released}`);

    const second = await depositToFunded(a);
    const rotsAt = second.refundsAt;

    console.log('');
    console.log(`completed deposit  ${first.id}  hash ${hash}`);
    console.log(`pending deposit    ${second.id}  refund window opens ${rotsAt} if it is still funded by then`);

    if (!first.id || !second.id) throw new Error('a fixture id is empty; refusing to write the config');
    writeConfig(
      assembleSepConfig({
        secret: demo.secret(),
        depositPending: { id: second.id },
        depositCompleted: { id: first.id, stellar_transaction_id: hash },
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
