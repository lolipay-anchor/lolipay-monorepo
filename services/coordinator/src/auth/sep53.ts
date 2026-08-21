import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';

const PREFIX = 'Stellar Signed Message:\n';

function decodeSignature(sig: string): Buffer | null {
  const s = sig.trim();

  const hex = s.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{128}$/.test(hex)) {
    return Buffer.from(hex, 'hex');
  }

  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return null;
  }
  const buf = Buffer.from(normalized, 'base64');
  return buf.length === 64 ? buf : null;
}

export function verifySep53(
  publicKey: string,
  message: string,
  signature: string,
): boolean {
  try {
    const sig = decodeSignature(signature);
    if (!sig) return false;
    const payload = Buffer.concat([
      Buffer.from(PREFIX, 'utf8'),
      Buffer.from(message, 'utf8'),
    ]);
    const hash = createHash('sha256').update(payload).digest();
    return Keypair.fromPublicKey(publicKey).verify(hash, sig);
  } catch {
    return false;
  }
}
