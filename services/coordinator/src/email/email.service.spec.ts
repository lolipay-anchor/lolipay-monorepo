import { EmailService, EMAIL_OUTBOX_KIND } from './email.service';

function make(opts: { apiKey?: string; email?: string | null; send?: jest.Mock<any, any> }) {
  const registered = new Map<string, (p: any) => Promise<void>>();
  const outbox = { register: jest.fn((k: string, h: any) => registered.set(k, h)) } as any;
  const prisma = {
    person: {
      findUnique: jest.fn(async () => (opts.email === undefined ? { email: 'a@b.test' } : opts.email === null ? null : { email: opts.email })),
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

  it('treats a person with no address on file as nothing to send, so the row is marked SENT rather than retried nine times and left FAILED forever', async () => {
    const send = jest.fn();
    const { handler } = make({ email: '', send });

    await expect(handler()({ personId: 'p1', subject: 'S', text: 'T' })).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('treats a person that no longer exists the same way — erased, not undeliverable', async () => {
    const send = jest.fn();
    const { handler } = make({ email: null, send });

    await expect(handler()({ personId: 'gone', subject: 'S', text: 'T' })).resolves.toBeUndefined();
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

  it('does not throw for an unconfigured key when there was nothing to send anyway', async () => {
    const { handler } = make({ apiKey: '', email: '' });
    await expect(handler()({ personId: 'p1', subject: 'S', text: 'T' })).resolves.toBeUndefined();
  });

  it('refuses a payload with no personId rather than resolving nothing and reporting success', async () => {
    const send = jest.fn();
    const { handler } = make({ send });
    await expect(handler()({ subject: 'S', text: 'T' })).rejects.toThrow(/personId/i);
    expect(send).not.toHaveBeenCalled();
  });
});
