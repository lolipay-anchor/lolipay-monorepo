import { execFileSync } from 'child_process';
import { Keypair } from '@stellar/stellar-sdk';
import { refuseForeignChallenge, sep53Signature } from './sep24-fixtures';

const API = 'https://api.lolipay.app';
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

async function sessionJwt(kp: Keypair): Promise<string> {
  const { nonce } = await postJson<{ nonce: string }>(`${API}/auth/challenge`, { address: kp.publicKey() });
  refuseForeignChallenge(nonce, kp.publicKey(), API);
  const { jwt } = await postJson<{ jwt: string }>(`${API}/auth/verify`, {
    address: kp.publicKey(),
    nonce,
    signature: sep53Signature(kp, nonce),
  });
  return jwt;
}

function keystoreSecret(identity: string): string {
  try {
    return execFileSync('stellar', ['keys', 'secret', identity], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`could not read keystore identity "${identity}"`);
  }
}

function row(body: string): { id?: unknown; label?: unknown; active?: unknown } {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function main(argv: string[]): Promise<void> {
  const [identity, id] = argv;
  if (!IDENTITY.test(identity ?? '') || !UUID.test(id ?? '')) {
    throw new Error('usage: lp-activate-payment-method <stellar-keystore-identity> <payment-method-uuid>');
  }
  const jwt = await sessionJwt(Keypair.fromSecret(keystoreSecret(identity)));

  const url = `${API}/lp/payment-methods/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ active: true }),
    redirect: 'error',
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`FAILED: PATCH ${url} -> ${res.status} ${text}`);
    process.exitCode = 1;
    return;
  }
  const { id: rowId, label, active } = row(text);
  if (active !== true) {
    console.error(`FAILED: PATCH ${url} -> ${res.status} but the row is still inactive: id=${String(rowId)} label=${String(label)} active=${String(active)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK: active=true id=${String(rowId)} label=${String(label)}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
