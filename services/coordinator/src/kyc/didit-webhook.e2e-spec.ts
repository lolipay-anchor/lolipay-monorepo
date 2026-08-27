import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'crypto';
import { bootAuthApp } from '../auth/auth-test-helpers';

const PATH = '/webhooks/didit';
const now = () => Math.floor(Date.now() / 1000);

function body(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    event_id: '11111111-2222-3333-4444-555555555555',
    webhook_type: 'status.updated',
    timestamp: now(),
    session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    status: 'In Progress',
    vendor_data: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    ...over,
  });
}

describe('the anchor accepts a delivery from Didit only when its bytes were signed', () => {
  let app: INestApplication;
  let secret: string;

  const post = (raw: string, headers: Record<string, string>) =>
    request(app.getHttpServer())
      .post(PATH)
      .set('content-type', 'application/json')
      .set(headers)
      .send(raw);

  const signed = (raw: string, ts = String(now())) => ({
    'x-signature': createHmac('sha256', secret).update(Buffer.from(raw, 'utf8')).digest('hex'),
    'x-timestamp': ts,
  });

  beforeAll(async () => {
    process.env.DIDIT_WEBHOOK_SECRET = 'example-webhook-secret-not-a-real-one';
    secret = process.env.DIDIT_WEBHOOK_SECRET;
    app = await bootAuthApp();
  });

  afterAll(async () => {
    delete process.env.DIDIT_WEBHOOK_SECRET;
    await app.close();
  });

  it('does not ask a vendor for a bearer token it cannot have', async () => {
    const res = await post(body(), signed(body()));
    expect(res.status).not.toBe(401);
  });

  it('accepts a correctly signed delivery', async () => {
    const raw = body();
    const res = await post(raw, signed(raw));
    expect(res.status).toBe(200);
  });

  it('refuses a delivery signed over the re-serialised body rather than the bytes sent', async () => {
    const raw = '{"event_id":"e","webhook_type":"status.updated","timestamp":' + now() +
      ',"session_id":"s","status":"In Progress","vendor_data":"G","2":3,"10":2}';
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    const res = await post(raw, {
      'x-signature': createHmac('sha256', secret).update(reserialised).digest('hex'),
      'x-timestamp': String(now()),
    });
    expect(res.status).toBe(401);
  });

  it('refuses a delivery with no signature at all', async () => {
    const res = await post(body(), { 'x-timestamp': String(now()) });
    expect(res.status).toBe(401);
  });

  it('refuses a delivery whose timestamp has gone stale', async () => {
    const raw = body();
    const res = await post(raw, signed(raw, String(now() - 400)));
    expect(res.status).toBe(401);
  });

  it('refuses a delivery signed with somebody else s secret', async () => {
    const raw = body();
    const res = await post(raw, {
      'x-signature': createHmac('sha256', 'example-secret-belonging-to-nobody').update(raw).digest('hex'),
      'x-timestamp': String(now()),
    });
    expect(res.status).toBe(401);
  });

  it('leaves every other route working, which capturing bytes could have broken', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/challenge')
      .send({ address: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ' });
    expect([201, 400, 429]).toContain(res.status);
  });

  it.each([
    ['a path spelled with different capitals', '/Webhooks/Didit', 'application/json'],
    ['a form content type the json parser declines', '/webhooks/didit', 'application/x-www-form-urlencoded'],
    ['no content type at all', '/webhooks/didit', ''],
  ])('refuses a delivery arriving as %s, where the bytes were never captured', async (_n, path, ct) => {
    const raw = body();
    const req = request(app.getHttpServer()).post(path);
    if (ct) req.set('content-type', ct);
    const res = await req.set(signed(raw)).send(raw);
    expect(res.status).toBe(401);
  });

  it('never repeats a vendor payload back to the caller', async () => {
    const raw = body({ vendor_data: 'GSECRETSUBJECT', extra_field: 'Budi Santoso' });
    const res = await post(raw, signed(raw));
    expect(JSON.stringify(res.body ?? '')).not.toContain('Budi Santoso');
    expect(res.text ?? '').not.toContain('Budi Santoso');
  });
});
