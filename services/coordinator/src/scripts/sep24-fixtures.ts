import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { Server } from '@stellar/stellar-sdk/rpc';

export function sep53Signature(kp: Keypair, nonce: string): string {
  const payload = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf8'),
    Buffer.from(nonce, 'utf8'),
  ]);
  return Buffer.from(kp.sign(createHash('sha256').update(payload).digest())).toString('base64');
}

export function signSep10Challenge(xdr: string, kp: Keypair, passphrase: string): string {
  const tx = new Transaction(xdr, passphrase);
  tx.sign(kp);
  return tx.toXdr();
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
const PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';
const HEARTBEAT_MS = 30_000;
const POLL_MS = 5_000;
const POLL_LIMIT_MS = 5 * 60_000;

function identity(name: string): Keypair {
  const secret = execFileSync('stellar', ['keys', 'secret', name], { encoding: 'utf8' }).trim();
  return Keypair.fromSecret(secret);
}

async function json<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
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

async function sep10Jwt(kp: Keypair): Promise<string> {
  const challenge = await json<{ transaction: string; network_passphrase: string }>(
    await fetch(`${API}/auth?account=${kp.publicKey()}&home_domain=${HOME_DOMAIN}`),
    'sep10 challenge',
  );
  const signed = signSep10Challenge(challenge.transaction, kp, challenge.network_passphrase);
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

async function readyLp(lpJwt: string, lpPub: string): Promise<() => void> {
  const me = await json<{ status: string; online: boolean; paymentMethods: Array<{ rail: string; currency: string; active: boolean }> }>(
    await fetch(`${API}/lp/me`, { headers: bearer(lpJwt) }),
    'lp/me',
  );
  const eligibility = await json<{ eligible: boolean; staked: string }>(
    await fetch(`${API}/lp/eligibility`, { headers: bearer(lpJwt) }),
    'lp/eligibility',
  );
  const missing: string[] = [];
  if (me.status !== 'APPROVED') missing.push(`provider ${lpPub} is ${me.status}, not APPROVED`);
  if (!eligibility.eligible) missing.push(`provider is not eligible (staked ${eligibility.staked})`);
  if (!me.paymentMethods.some((m) => m.rail === 'BANK' && m.currency === 'IDR' && m.active)) {
    missing.push('provider has no active BANK/IDR payment method');
  }
  if (missing.length) throw new Error(`the provider cannot be matched:\n  ${missing.join('\n  ')}`);
  if (!me.online) {
    await json(
      await fetch(`${API}/lp/availability`, {
        method: 'POST',
        headers: { ...bearer(lpJwt), 'content-type': 'application/json' },
        body: JSON.stringify({ available: true }),
      }),
      'lp/availability',
    );
  }
  const beat = () => fetch(`${API}/lp/heartbeat`, { method: 'POST', headers: bearer(lpJwt) }).catch(() => undefined);
  await beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  return () => clearInterval(timer);
}

async function openDeposit(demoJwt: string): Promise<{ id: string; cookie: string; url: string }> {
  const opened = await json<{ id: string; url: string }>(
    await fetch(`${API}/sep24/transactions/deposit/interactive`, {
      method: 'POST',
      headers: { ...bearer(demoJwt), 'content-type': 'application/json' },
      body: JSON.stringify({ asset_code: 'USDC' }),
    }),
    'deposit/interactive',
  );
  const hop = await fetch(opened.url, { redirect: 'manual' });
  const setCookie = hop.headers.get('set-cookie') ?? '';
  if (hop.status !== 302 || !setCookie) {
    throw new Error(`interactive link did not set a session: HTTP ${hop.status}`);
  }
  return { id: opened.id, cookie: setCookie.split(';')[0], url: opened.url };
}

type Screen = 'identity' | 'waiting' | 'amount' | 'other';

async function screenOf(id: string, cookie: string): Promise<Screen> {
  const page = await (await fetch(`${API}/sep24/interactive/${id}`, { headers: { cookie } })).text();
  const title = (page.match(/<h1>([^<]*)<\/h1>/) ?? [])[1] ?? '';
  if (/verify your identity/i.test(title)) return 'identity';
  if (/checking your identity/i.test(title)) return 'waiting';
  if (/how much would you like/i.test(title)) return 'amount';
  return 'other';
}

async function postForm(id: string, step: string, cookie: string, fields: Record<string, string>): Promise<void> {
  const res = await fetch(`${API}/sep24/interactive/${id}/${step}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  if (res.status !== 302) throw new Error(`${step}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function assertScreened(id: string, cookie: string, url: string): Promise<void> {
  let screen = await screenOf(id, cookie);
  if (screen === 'identity') {
    await postForm(id, 'identity', cookie, {
      first_name: 'Budi',
      last_name: 'Santoso',
      email_address: 'budi.santoso@example.com',
      id_type: 'id_card',
      id_country_code: 'IDN',
    });
    const until = Date.now() + 60_000;
    while (Date.now() < until && (screen = await screenOf(id, cookie)) !== 'amount') {
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  if (screen !== 'amount') {
    throw new Error(
      [
        'The demo account has no screened identity.',
        `Open this link in a desktop browser within 5 minutes and complete the Didit KYC+AML session, then re-run:`,
        `  ${url}`,
      ].join('\n'),
    );
  }
}

async function newestOrderFor(lpJwt: string, userPub: string): Promise<{ id: string; status: string }> {
  const rows = await json<Array<{ order: { id: string; status: string; user_address?: string; userAddress?: string; created_at?: string } }>>(
    await fetch(`${API}/lp/assignments`, { headers: bearer(lpJwt) }),
    'lp/assignments',
  );
  const mine = rows.map((r) => r.order).filter((o) => (o.user_address ?? o.userAddress) === userPub);
  if (!mine.length) throw new Error('no assignment found for the demo account after the amount step');
  return mine[mine.length - 1];
}

async function xdrFor(jwt: string, orderId: string, leg: string): Promise<{ xdr: string; networkPassphrase: string }> {
  return json(await fetch(`${API}/orders/${orderId}/tx/${leg}`, { headers: bearer(jwt) }), `tx/${leg}`);
}

async function signAndSubmit(kp: Keypair, built: { xdr: string; networkPassphrase: string }): Promise<string> {
  const server = new Server(RPC_URL);
  const tx = new Transaction(built.xdr, built.networkPassphrase);
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error(`submit refused: ${JSON.stringify(sent.errorResult)}`);
  const until = Date.now() + POLL_LIMIT_MS;
  while (Date.now() < until) {
    const got = await server.getTransaction(sent.hash);
    if (got.status === 'SUCCESS') return sent.hash;
    if (got.status === 'FAILED') throw new Error(`transaction ${sent.hash} failed on chain`);
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`transaction ${sent.hash} not confirmed within ${POLL_LIMIT_MS / 1000}s`);
}

async function waitForSep24(demoJwt: string, id: string, status: string): Promise<{ status: string; stellar_transaction_id: string | null }> {
  const until = Date.now() + POLL_LIMIT_MS;
  while (Date.now() < until) {
    const { transaction } = await json<{ transaction: { status: string; stellar_transaction_id: string | null } }>(
      await fetch(`${API}/sep24/transaction?id=${id}`, { headers: bearer(demoJwt) }),
      'sep24/transaction',
    );
    if (transaction.status === status) return transaction;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`transaction ${id} did not reach ${status} within ${POLL_LIMIT_MS / 1000}s`);
}

async function depositToFunded(demo: Keypair, demoSep10: string, lp: Keypair, lpJwt: string) {
  const { id, cookie, url } = await openDeposit(demoSep10);
  await assertScreened(id, cookie, url);
  await postForm(id, 'amount', cookie, { fiat_amount: DEMO_IDR });
  const order = await newestOrderFor(lpJwt, demo.publicKey());
  console.log(`deposit ${id}: order ${order.id} ${order.status}`);
  const funded = await signAndSubmit(lp, await xdrFor(lpJwt, order.id, 'create-trade'));
  console.log(`  escrow funded by the provider: ${funded}`);
  await waitForSep24(demoSep10, id, 'pending_user_transfer_start');
  return { id, orderId: order.id };
}

async function main(): Promise<void> {
  const demo = identity(process.env.SEP24_DEMO_IDENTITY ?? 'sep24-demo');
  const lp = identity(process.env.SEP24_LP_IDENTITY ?? 'e2e-provider');
  console.log(`demo account ${demo.publicKey()}`);
  console.log(`provider     ${lp.publicKey()}`);

  const lpJwt = await sessionJwt(lp);
  const stop = await readyLp(lpJwt, lp.publicKey());
  try {
    const demoJwt = await sessionJwt(demo);
    const demoSep10 = await sep10Jwt(demo);

    const first = await depositToFunded(demo, demoSep10, lp, lpJwt);
    const paid = await signAndSubmit(demo, await xdrFor(demoJwt, first.orderId, 'mark-paid'));
    console.log(`  rupiah marked paid by the depositor: ${paid}`);
    const released = await signAndSubmit(lp, await xdrFor(lpJwt, first.orderId, 'confirm-release'));
    console.log(`  escrow released by the provider: ${released}`);
    const done = await waitForSep24(demoSep10, first.id, 'completed');
    let hash = done.stellar_transaction_id;
    for (let i = 0; i < 6 && !hash; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      hash = (await waitForSep24(demoSep10, first.id, 'completed')).stellar_transaction_id;
    }
    if (!hash) throw new Error(`deposit ${first.id} is completed but carries no stellar_transaction_id`);
    if (hash !== released) throw new Error(`recorded hash ${hash} is not the release transaction ${released}`);

    const second = await depositToFunded(demo, demoSep10, lp, lpJwt);

    if (!first.id || !second.id) throw new Error('a fixture id is empty; refusing to write the config');
    const cfg = assembleSepConfig({
      secret: demo.secret(),
      depositPending: { id: second.id },
      depositCompleted: { id: first.id, stellar_transaction_id: hash },
    });
    writeFileSync('anchor-tests/sep-config.local.json', JSON.stringify(cfg, null, 2) + '\n');
    console.log('');
    console.log(`completed deposit  ${first.id}  hash ${hash}`);
    console.log(`pending deposit    ${second.id}`);
    console.log('wrote anchor-tests/sep-config.local.json; run npm run anchor:test:sep24 within 60 minutes');
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
