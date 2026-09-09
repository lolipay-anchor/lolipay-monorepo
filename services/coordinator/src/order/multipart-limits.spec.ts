import express from 'express';
import { NO_BRACKETED_FIELD_NAMES } from './multipart-limits';
import { UPLOAD_OPTS } from './order.controller';
import { SEP24_INTERACTIVE_LIMITS } from '../sep24/sep24.controller';

const multer = require('multer');

const body = (name: string) =>
  `--x\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n1\r\n--x--\r\n`;

async function post(limits: unknown, name: string): Promise<{ status: number; text: string }> {
  const app = express();
  app.post('/u', multer({ limits }).any(), (_req: any, res: any) => res.status(200).send('PARSED'));
  app.use((err: any, _req: any, res: any, _next: any) => res.status(400).send(`REFUSED ${err?.code}`));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/u`, {
      method: 'POST',
      body: body(name),
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    return { status: res.status, text: await res.text() };
  } finally {
    server.close();
  }
}

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

  it('arms the guard from one shared constant, so the two controllers cannot drift apart', () => {
    expect(NO_BRACKETED_FIELD_NAMES).toEqual({ fieldNestingDepth: 0 });
    expect(UPLOAD_OPTS.limits).toMatchObject(NO_BRACKETED_FIELD_NAMES);
    expect(SEP24_INTERACTIVE_LIMITS.limits).toMatchObject(NO_BRACKETED_FIELD_NAMES);
  });
});
