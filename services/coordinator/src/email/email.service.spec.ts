import { EmailService, EMAIL_OUTBOX_KIND } from './email.service';

function make(opts: {
  apiKey?: string;
  email?: string | null;
  lp?: { alertEmail: string | null } | null;
  send?: jest.Mock<any, any>;
}) {
  const registered = new Map<string, (p: any) => Promise<void>>();
  const outbox = { register: jest.fn((k: string, h: any) => registered.set(k, h)) } as any;
  const prisma = {
    person: {
      findUnique: jest.fn(async () => (opts.email === undefined ? { email: 'a@b.test' } : opts.email === null ? null : { email: opts.email })),
    },
    lp: {
      findUnique: jest.fn(async () => (opts.lp === undefined ? null : opts.lp)),
      findFirst: jest.fn(async () => (opts.lp === undefined ? null : opts.lp)),
    },
  } as any;
  const cfg = { resendApiKey: opts.apiKey ?? 'key', resendFrom: 'lolipay <support@lolipay.app>' } as any;
  const svc = new EmailService(cfg, outbox, prisma);
  if (opts.send) (svc as any).post = opts.send;
  svc.onModuleInit();
  return { svc, prisma, registered, handler: () => registered.get(EMAIL_OUTBOX_KIND)! };
}

describe('the email channel', () => {
  it('registers itself with the outbox, or nothing it queues is ever drained', () => {
    expect(make({}).registered.has(EMAIL_OUTBOX_KIND)).toBe(true);
  });

  it('carries only a personId and resolves the address at send time, so the queue never stores an address', async () => {
    const send = jest.fn(async () => ({ ok: true, status: 200, body: '{}' }));
    const { handler, prisma } = make({ send });

    await handler()({ personId: 'p1', subject: 'S', text: 'T' });

    expect(prisma.person.findUnique).toHaveBeenCalledWith({ where: { id: 'p1' }, select: { email: true } });
    const sent = (send.mock.calls as any[])[0][0];
    expect(sent.to).toEqual(['a@b.test']);
    expect(sent.from).toBe('lolipay <support@lolipay.app>');
    expect(sent.subject).toBe('S');
    expect(sent.text).toBe('T');
  });

  it('refuses a person with no address on file, so the outbox retries instead of recording a delivery that never happened', async () => {
    const send = jest.fn();
    const { handler } = make({ email: '', send });

    await expect(handler()({ personId: 'p1', subject: 'S', text: 'T' })).rejects.toThrow(
      'no address on file for this person, so nothing was delivered',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a person that no longer exists the same way, rather than reporting a send to an erased recipient', async () => {
    const send = jest.fn();
    const { handler } = make({ email: null, send });

    await expect(handler()({ personId: 'gone', subject: 'S', text: 'T' })).rejects.toThrow(
      'no address on file for this person, so nothing was delivered',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('throws when the provider refuses, so the outbox retries instead of recording a send that never happened', async () => {
    const send = jest.fn(async () => ({ ok: false, status: 422, body: 'suppressed' }));
    const { handler } = make({ send });
    await expect(handler()({ personId: 'p1', subject: 'S', text: 'T' })).rejects.toThrow(/refused with 422/);
  });

  it('throws rather than silently succeeding when no API key is configured AND there was something to send', async () => {
    const send = jest.fn();
    const { handler } = make({ apiKey: '', send });
    await expect(handler()({ personId: 'p1', subject: 'S', text: 'T' })).rejects.toThrow(/not configured/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('blames the missing address rather than the missing API key when both are absent, so the recorded reason is the true one', async () => {
    const { handler } = make({ apiKey: '', email: '' });
    await expect(handler()({ personId: 'p1', subject: 'S', text: 'T' })).rejects.toThrow(
      'no address on file for this person, so nothing was delivered',
    );
  });

  it('refuses a payload with no personId rather than resolving nothing and reporting success', async () => {
    const send = jest.fn();
    const { handler } = make({ send });
    await expect(handler()({ subject: 'S', text: 'T' })).rejects.toThrow(/personId/i);
    expect(send).not.toHaveBeenCalled();
  });

  describe('ADR 0054 — the provider alert address', () => {
    it('9 — a job whose lpId resolves to an Lp row with alertEmail sends there, preferred over the person\'s', async () => {
      const send = jest.fn(async () => ({ ok: true, status: 200, body: '{}' }));
      const { handler, prisma } = make({ send, lp: { alertEmail: 'ops@example.com' } });

      await handler()({ lpId: 'lp1', personId: 'p1', subject: 'S', text: 'T' });

      const sent = (send.mock.calls as any[])[0][0];
      expect(sent.to).toEqual(['ops@example.com']);

      const lpCalls = [
        ...(prisma.lp.findUnique as jest.Mock).mock.calls,
        ...(prisma.lp.findFirst as jest.Mock).mock.calls,
      ];
      expect(lpCalls.length).toBeGreaterThan(0);
      const args = lpCalls[0][0] as any;
      expect(args?.select?.alertEmail === true || args?.omit?.alertEmail === false).toBe(true);
    });

    it("9b — a job whose lpId resolves to an Lp row with NO alertEmail is refused, and never falls back to Person.email even when a personId is also present: lpId alone marks this as a provider job, narrowed ADR 0054", async () => {
      const send = jest.fn();
      const { handler } = make({ send, lp: { alertEmail: null } });

      await expect(handler()({ lpId: 'lp1', personId: 'p1', subject: 'S', text: 'T' })).rejects.toThrow(
        'no address on file for this person, so nothing was delivered',
      );
      expect(send).not.toHaveBeenCalled();
    });

    it('9d — a job with lpId and no personId at all does not throw "carries no personId", and delivers via Lp.alertEmail', async () => {
      const send = jest.fn(async () => ({ ok: true, status: 200, body: '{}' }));
      const { handler } = make({ send, lp: { alertEmail: 'ops@example.com' } });

      await expect(handler()({ lpId: 'lp1', subject: 'S', text: 'T' })).resolves.toBeUndefined();

      const sent = (send.mock.calls as any[])[0][0];
      expect(sent.to).toEqual(['ops@example.com']);
    });
  });
});
