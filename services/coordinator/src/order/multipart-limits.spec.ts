import express from 'express';
import { NO_BRACKETED_FIELD_NAMES } from './multipart-limits';
import { UPLOAD_OPTS } from './order.controller';
import { SEP24_INTERACTIVE_LIMITS } from '../sep24/sep24.controller';

const multer = require('multer');

const body = (name: string) =>
  `--x\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n1\r\n--x--\r\n`;

const partsWithNoDisposition = (count: number) => `--x\r\nA: B\r\n\r\n\r\n`.repeat(count) + `--x--\r\n`;

async function postBody(limits: unknown, raw: string): Promise<{ status: number; text: string }> {
  const app = express();
  app.post('/u', multer({ limits }).any(), (_req: any, res: any) => res.status(200).send('PARSED'));
  app.use((err: any, _req: any, res: any, _next: any) => res.status(400).send(`REFUSED ${err?.code}`));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/u`, {
      method: 'POST',
      body: raw,
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    return { status: res.status, text: await res.text() };
  } finally {
    server.close();
  }
}

const post = (limits: unknown, name: string) => postBody(limits, body(name));

describe('a bracketed field name is refused before it is parsed, on every route that reads multipart', () => {
  it.each([
    ['the payment-proof and dispute-evidence routes', () => UPLOAD_OPTS.limits],
    ['the SEP-24 interactive routes', () => SEP24_INTERACTIVE_LIMITS.limits],
  ])('%s refuse it', async (_label, limits) => {
    const res = await post(limits(), 'items[0]');

    expect(res.text).toBe('REFUSED LIMIT_FIELD_NESTING');
    expect(res.status).toBe(400);
  });

  it('still accepts the plain field names the real forms send', async () => {
    const res = await post(UPLOAD_OPTS.limits, 'rrn');

    expect(res.text).toBe('PARSED');
  });

  it.each([
    ['the payment-proof and dispute-evidence routes', () => UPLOAD_OPTS.limits],
    ['the SEP-24 interactive routes', () => SEP24_INTERACTIVE_LIMITS.limits],
  ])('%s refuse a body of parts that carry no disposition, which busboy never counts as a field or a file', async (_label, limits) => {
    const res = await postBody(limits(), partsWithNoDisposition(20_000));

    expect(res.text).toBe('REFUSED LIMIT_PART_COUNT');
    expect(res.status).toBe(400);
  });

  it.each([
    ['the payment-proof and dispute-evidence routes', () => UPLOAD_OPTS.limits],
    ['the SEP-24 interactive routes', () => SEP24_INTERACTIVE_LIMITS.limits],
  ])('%s bound parts just above their own field ceiling, because fields and files do not bound the ones busboy skips', (_label, limits) => {
    const { parts, fields, fieldSize } = limits() as { parts?: number; fields?: number; fieldSize?: number };

    expect(typeof parts).toBe('number');
    expect(typeof fields).toBe('number');
    expect(typeof fieldSize).toBe('number');
    expect(parts).toBeGreaterThan(fields as number);
    expect(parts).toBeLessThanOrEqual((fields as number) + 5);
  });

  it('arms the guard from one shared constant, so the two controllers cannot drift apart', () => {
    expect(NO_BRACKETED_FIELD_NAMES).toEqual({ fieldNestingDepth: 0 });
    expect(UPLOAD_OPTS.limits).toMatchObject(NO_BRACKETED_FIELD_NAMES);
    expect(SEP24_INTERACTIVE_LIMITS.limits).toMatchObject(NO_BRACKETED_FIELD_NAMES);
  });
});
