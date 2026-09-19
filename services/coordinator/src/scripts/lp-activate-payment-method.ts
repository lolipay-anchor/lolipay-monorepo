import { execFileSync } from 'child_process';
import { Keypair } from '@stellar/stellar-sdk';
import { sep53Signature } from './sep24-fixtures';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

async function sessionJwt(api: string, kp: Keypair): Promise<string> {
  const { nonce } = await postJson<{ nonce: string }>(`${api}/auth/challenge`, { address: kp.publicKey() });
  const { jwt } = await postJson<{ jwt: string }>(`${api}/auth/verify`, {
    address: kp.publicKey(),
    nonce,
    signature: sep53Signature(kp, nonce),
  });
  return jwt;
}

function saysActive(body: string): boolean {
  try {
    return (JSON.parse(body) as { active?: unknown }).active === true;
  } catch {
    return false;
  }
}

export async function main(argv: string[]): Promise<void> {
  const [identity, id] = argv;
  if (!identity || !id) {
    throw new Error('usage: lp-activate-payment-method <stellar-keystore-identity> <payment-method-id>');
  }
  const api = process.env.SEP24_API ?? 'https://api.lolipay.app';
  const secret = execFileSync('stellar', ['keys', 'secret', identity], { encoding: 'utf8' }).trim();
  const jwt = await sessionJwt(api, Keypair.fromSecret(secret));

  const res = await fetch(`${api}/lp/payment-methods/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ active: true }),
  });
  const text = await res.text();
  console.log(`PATCH ${api}/lp/payment-methods/${id} -> ${res.status} ${text}`);
  if (!res.ok || !saysActive(text)) process.exitCode = 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
