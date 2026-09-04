import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'crypto';
import { bootAuthApp, sessionToken } from '../auth/auth-test-helpers';
import { Keypair } from '@stellar/stellar-sdk';
import { PrismaService } from '../prisma/prisma.service';

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

  let prisma: PrismaService;
  let savedEnv: string | undefined;

  beforeAll(async () => {
    process.env.DIDIT_WEBHOOK_SECRET = 'example-webhook-secret-not-a-real-one';
    savedEnv = process.env.DIDIT_ENVIRONMENT;
    process.env.DIDIT_ENVIRONMENT = 'sandbox';
    secret = process.env.DIDIT_WEBHOOK_SECRET;
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    delete process.env.DIDIT_WEBHOOK_SECRET;
    if (savedEnv === undefined) delete process.env.DIDIT_ENVIRONMENT;
    else process.env.DIDIT_ENVIRONMENT = savedEnv;
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
    ['a form content type the json parser declines', '/webhooks/didit', 'application/x-www-form-urlencoded'],
    ['no content type at all', '/webhooks/didit', ''],
  ])('refuses a delivery arriving as %s, where the bytes were never captured', async (_n, path, ct) => {
    const raw = body();
    const req = request(app.getHttpServer()).post(path);
    if (ct) req.set('content-type', ct);
    const sent = req.set(signed(raw)).send(raw);
    const res = await (ct ? sent : (sent as any).unset('Content-Type'));
    expect(res.status).toBe(401);
  });

  it('reads a delivery whose path was registered with different capitals, because the signature authenticates it and the spelling does not', async () => {
    const raw = body();
    const res = await request(app.getHttpServer())
      .post('/Webhooks/Didit')
      .set('content-type', 'application/json')
      .set(signed(raw))
      .send(raw);
    expect(res.status).toBe(200);
  });

  it('still refuses an unsigned delivery on that same differently spelled path', async () => {
    const raw = body();
    const res = await request(app.getHttpServer())
      .post('/Webhooks/Didit')
      .set('content-type', 'application/json')
      .set({ 'x-signature': 'deadbeef', 'x-timestamp': String(Math.floor(Date.now() / 1000)) })
      .send(raw);
    expect(res.status).toBe(401);
  });

  it('records a screened approval against a person the anchor already knows', async () => {
    const kp = Keypair.random();
    await sessionToken(app, kp);

    const raw = JSON.stringify({
      event_id: 'e-1',
      webhook_type: 'status.updated',
      timestamp: Math.floor(Date.now() / 1000),
      session_id: 'sess-live-1',
      status: 'Approved',
      vendor_data: kp.publicKey(),
      environment: 'sandbox',
      decision: { aml_screenings: [{ status: 'Approved', total_hits: 0, hits: [], warnings: [] }] },
    });
    await post(raw, signed(raw)).expect(200);

    const row = await prisma.kycVerification.findUnique({
      where: { customerRef: kp.publicKey() },
    });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('ACCEPTED');
    expect(row!.screenedAt).not.toBeNull();
    expect(row!.environment).toBe('sandbox');
    expect(row!.personId).not.toBeNull();
  });

  it('refuses an approval whose screening carried a hit, records the refusal against the person', async () => {
    const kp = Keypair.random();
    await sessionToken(app, kp);

    const raw = JSON.stringify({
      event_id: 'e-hit',
      webhook_type: 'status.updated',
      timestamp: Math.floor(Date.now() / 1000),
      session_id: 'sess-live-hit',
      status: 'Approved',
      vendor_data: kp.publicKey(),
      environment: 'sandbox',
      decision: { aml_screenings: [{ status: 'Approved', total_hits: 1, hits: [{ score: 0.4 }], warnings: [] }] },
    });
    await post(raw, signed(raw)).expect(200);

    const row = await prisma.kycVerification.findUnique({ where: { customerRef: kp.publicKey() } });
    expect(row!.status).toBe('REJECTED');
    expect(row!.rejectionReason).toBe('sanctions or watchlist match');
    expect(row!.screenedAt).toBeNull();
  });

  it('asks a customer again when the vendor approved them with a screening this anchor cannot read, and marks the row so the monitor can count it', async () => {
    const kp = Keypair.random();
    await sessionToken(app, kp);

    const raw = JSON.stringify({
      event_id: 'e-unreadable',
      webhook_type: 'status.updated',
      timestamp: Math.floor(Date.now() / 1000),
      session_id: 'sess-live-unreadable',
      status: 'Approved',
      vendor_data: kp.publicKey(),
      environment: 'sandbox',
      decision: { aml_screenings: [{ status: 'Approved', total_hits: 0, hits: [], warnings: ['SOME_NEW_WARNING'] }] },
    });
    await post(raw, signed(raw)).expect(200);

    const row = await prisma.kycVerification.findUnique({ where: { customerRef: kp.publicKey() } });
    expect(row!.status).toBe('NEEDS_INFO');
    expect(row!.rejectionReason).toBe('the screening could not be read');
    expect(row!.deliveredAt).not.toBeNull();
    expect(row!.screenedAt).toBeNull();
    expect(await prisma.kycVerification.count({ where: { status: 'NEEDS_INFO', rejectionReason: 'the screening could not be read', customerRef: kp.publicKey() } })).toBe(1);
  });

  it('writes nothing at all when the delivery came from another environment', async () => {
    const kp = Keypair.random();
    await sessionToken(app, kp);

    const raw = JSON.stringify({
      event_id: 'e-2',
      timestamp: Math.floor(Date.now() / 1000),
      session_id: 'sess-live-2',
      status: 'Approved',
      vendor_data: kp.publicKey(),
      environment: 'live',
      decision: { aml_screenings: [{ status: 'Approved', total_hits: 0, hits: [], warnings: [] }] },
    });
    await post(raw, signed(raw)).expect(200);

    const row = await prisma.kycVerification.findUnique({
      where: { customerRef: kp.publicKey() },
    });
    expect(row).toBeNull();
  });

  it.each([
    ['a timestamp in milliseconds, which would sort past every later delivery', () => Date.now()],
    ['a timestamp far in the future', () => Math.floor(Date.now() / 1000) + 86400],
    ['a timestamp far in the past', () => Math.floor(Date.now() / 1000) - 86400],
    ['no timestamp the anchor can read', () => 'tomorrow'],
  ])('writes nothing for a delivery carrying %s', async (_n, bodyTime) => {
    const kp = Keypair.random();
    await sessionToken(app, kp);
    const raw = JSON.stringify({
      timestamp: bodyTime(),
      session_id: 'sess-clock',
      status: 'Approved',
      vendor_data: kp.publicKey(),
      environment: 'sandbox',
      decision: { aml_screenings: [{ status: 'Approved', total_hits: 0, hits: [], warnings: [] }] },
    });
    await post(raw, signed(raw)).expect(200);
    expect(await prisma.kycVerification.findUnique({ where: { customerRef: kp.publicKey() } })).toBeNull();
  });

  it('writes nothing when the delivery names its customer as something that is not an address', async () => {
    const raw = JSON.stringify({
      timestamp: Math.floor(Date.now() / 1000),
      session_id: 'sess-odd',
      status: 'Approved',
      vendor_data: { not: 'a string' },
      environment: 'sandbox',
      decision: { aml_screenings: [] },
    });
    const before = await prisma.kycVerification.count();
    const res = await post(raw, signed(raw));
    expect(res.status).toBe(200);
    expect(await prisma.kycVerification.count()).toBe(before);
  });

  it('never repeats a vendor payload back to the caller', async () => {
    const raw = body({ vendor_data: 'GSECRETSUBJECT', extra_field: 'Budi Santoso' });
    const res = await post(raw, signed(raw));
    expect(JSON.stringify(res.body ?? '')).not.toContain('Budi Santoso');
    expect(res.text ?? '').not.toContain('Budi Santoso');
  });
});
