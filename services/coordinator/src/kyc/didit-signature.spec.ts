import { createHmac } from 'crypto';
import { verifyDiditDelivery } from './didit-signature';

const SECRET = 'example-webhook-secret-not-a-real-one';
const RAW = Buffer.from('{"b": 1,\n  "a":"héllo", "2":3, "10":2}', 'utf8');
const now = () => Math.floor(Date.now() / 1000);

const sign = (body: Buffer, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

function delivery(over: Partial<{ raw: Buffer; signature: string; timestamp: string }> = {}) {
  const raw = over.raw ?? RAW;
  return {
    raw,
    signature: over.signature ?? sign(raw),
    timestamp: over.timestamp ?? String(now()),
    secret: SECRET,
  };
}

describe('a delivery is trusted only when its bytes were signed by the shared secret', () => {
  it('accepts a signature over the exact bytes that arrived', () => {
    expect(verifyDiditDelivery(delivery())).toEqual({ trusted: true });
  });

  it('refuses a signature over the same JSON re-serialised, which is what a body parser hands you', () => {
    const reStringified = Buffer.from(JSON.stringify(JSON.parse(RAW.toString('utf8'))), 'utf8');
    expect(reStringified.equals(RAW)).toBe(false);
    const res = verifyDiditDelivery(delivery({ signature: sign(reStringified) }));
    expect(res).toEqual({ trusted: false, reason: 'signature does not match the bytes that arrived' });
  });

  it('refuses a signature made with a different secret', () => {
    expect(verifyDiditDelivery(delivery({ signature: sign(RAW, 'example-secret-belonging-to-nobody') })).trusted).toBe(false);
  });

  it('refuses a body that was altered after signing', () => {
    const tampered = Buffer.from(RAW.toString('utf8').replace('"b": 1', '"b": 2'), 'utf8');
    expect(tampered.equals(RAW)).toBe(false);
    const res = verifyDiditDelivery({ ...delivery(), raw: tampered });
    expect(res.trusted).toBe(false);
  });

  it.each([
    ['older than five minutes', String(now() - 301)],
    ['further ahead than five minutes', String(now() + 301)],
    ['not a number', 'yesterday'],
    ['absent', ''],
  ])('refuses a delivery whose timestamp is %s', (_name, timestamp) => {
    const res = verifyDiditDelivery(delivery({ timestamp }));
    expect(res).toEqual({ trusted: false, reason: 'timestamp is outside the freshness window' });
  });

  it('accepts a timestamp just inside the window on either side', () => {
    for (const ts of [now() - 299, now() + 299]) {
      expect(verifyDiditDelivery(delivery({ timestamp: String(ts) })).trusted).toBe(true);
    }
  });

  it('checks freshness before doing any signature work', () => {
    const res = verifyDiditDelivery(delivery({ timestamp: String(now() - 9999), signature: 'nonsense' }));
    expect(res.reason).toBe('timestamp is outside the freshness window');
  });

  it.each([
    ['absent', ''],
    ['a different length', 'abcd'],
    ['not hexadecimal', 'z'.repeat(64)],
  ])('refuses a signature that is %s, without throwing', (_name, signature) => {
    expect(() => verifyDiditDelivery(delivery({ signature }))).not.toThrow();
    expect(verifyDiditDelivery(delivery({ signature })).trusted).toBe(false);
  });

  it('refuses everything when no secret is configured, rather than trusting anything', () => {
    const res = verifyDiditDelivery({ ...delivery(), secret: '' });
    expect(res).toEqual({ trusted: false, reason: 'no webhook secret is configured' });
  });

  it('refuses a delivery whose bytes were never captured, rather than hashing nothing', () => {
    const empty = Buffer.alloc(0);
    const res = verifyDiditDelivery(delivery({ raw: empty }));
    expect(res).toEqual({ trusted: false, reason: 'the bytes of this delivery were not captured' });
  });

  it('refuses when the raw body is missing entirely', () => {
    const res = verifyDiditDelivery({ ...delivery(), raw: undefined });
    expect(res).toEqual({ trusted: false, reason: 'the bytes of this delivery were not captured' });
  });

  it.each([
    ['exactly at the past edge of the window', 300, false],
    ['exactly at the future edge of the window', -300, false],
    ['one second inside it, in the past', 299, true],
    ['one second inside it, in the future', -299, true],
  ])('treats a timestamp %s as trusted=%s', (_n, offset, trusted) => {
    expect(verifyDiditDelivery(delivery({ timestamp: String(now() - offset) })).trusted).toBe(trusted);
  });
});
