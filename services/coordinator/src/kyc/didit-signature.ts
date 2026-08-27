import { createHmac, timingSafeEqual } from 'crypto';

export const DIDIT_FRESHNESS_SECS = 300;

export type DeliveryVerdict = { trusted: boolean; reason?: string };

export function verifyDiditDelivery(delivery: {
  raw: Buffer;
  signature: string;
  timestamp: string;
  secret: string;
}): DeliveryVerdict {
  const { raw, signature, timestamp, secret } = delivery;

  if (!secret) return { trusted: false, reason: 'no webhook secret is configured' };

  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || timestamp.trim() === '') {
    return { trusted: false, reason: 'timestamp is outside the freshness window' };
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - sent) > DIDIT_FRESHNESS_SECS) {
    return { trusted: false, reason: 'timestamp is outside the freshness window' };
  }

  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { trusted: false, reason: 'signature does not match the bytes that arrived' };
  }
  return { trusted: true };
}
