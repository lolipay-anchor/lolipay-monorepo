import { Logger } from '@nestjs/common';
import { OutboxService, OUTBOX_MAX_ATTEMPTS } from './outbox.service';

function makePrisma(pending: any[] = []) {
  const updates: any[] = [];
  const created: any[] = [];
  const prisma: any = {
    outboxMessage: {
      create: jest.fn(async ({ data }: any) => { created.push(data); return data; }),
      findMany: jest.fn(async () => pending),
      updateMany: jest.fn(async (args: any) => { updates.push(args); return { count: 1 }; }),
    },
  };
  return { prisma, updates, created };
}

const msg = (over: any = {}) => ({
  id: 'm1', kind: 'email', payload: { to: 'a@b.c' }, attempts: 0, status: 'PENDING', ...over,
});

describe('OutboxService.enqueue', () => {
  it('writes through the transaction client it is handed, not its own', async () => {
    const { prisma } = makePrisma();
    const svc = new OutboxService(prisma);
    const tx = { outboxMessage: { create: jest.fn(async () => ({})) } };

    await svc.enqueue(tx as any, { kind: 'email', payload: { a: 1 } });

    expect(tx.outboxMessage.create).toHaveBeenCalled();
    expect(prisma.outboxMessage.create).not.toHaveBeenCalled();
  });

  it('is idempotent on a duplicate dedupe key rather than throwing', async () => {
    const svc = new OutboxService(makePrisma().prisma);
    const tx = {
      outboxMessage: {
        create: jest.fn(async () => { const e: any = new Error('dup'); e.code = 'P2002'; throw e; }),
      },
    };
    await expect(svc.enqueue(tx as any, { kind: 'email', payload: {}, dedupeKey: 'k' })).resolves.toBeUndefined();
  });

  it('still surfaces a real database error', async () => {
    const svc = new OutboxService(makePrisma().prisma);
    const tx = { outboxMessage: { create: jest.fn(async () => { throw new Error('disk full'); }) } };
    await expect(svc.enqueue(tx as any, { kind: 'email', payload: {} })).rejects.toThrow('disk full');
  });
});

describe('OutboxService.drainOnce', () => {
  it('marks a delivered message SENT', async () => {
    const { prisma, updates } = makePrisma([msg()]);
    const svc = new OutboxService(prisma);
    svc.register('email', async () => undefined);

    expect(await svc.drainOnce()).toBe(1);
    expect(updates[0].data).toMatchObject({ status: 'SENT' });
    expect(updates[0].where).toMatchObject({ id: 'm1', status: 'PENDING' });
  });

  it('leaves a failed message PENDING and counts the attempt', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { prisma, updates } = makePrisma([msg()]);
    const svc = new OutboxService(prisma);
    svc.register('email', async () => { throw new Error('smtp down'); });

    expect(await svc.drainOnce()).toBe(0);
    expect(updates[0].data).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(updates[0].data.lastError).toContain('smtp down');
    warn.mockRestore();
  });

  it('gives up loudly once the attempts are exhausted', async () => {
    const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { prisma, updates } = makePrisma([msg({ attempts: OUTBOX_MAX_ATTEMPTS - 1 })]);
    const svc = new OutboxService(prisma);
    svc.register('email', async () => { throw new Error('permanently broken'); });

    await svc.drainOnce();

    expect(updates[0].data).toMatchObject({ status: 'FAILED', attempts: OUTBOX_MAX_ATTEMPTS });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('will not be retried'));
    err.mockRestore();
  });

  it('does not silently discard a message whose kind has no handler', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { prisma, updates } = makePrisma([msg({ kind: 'unregistered' })]);
    const svc = new OutboxService(prisma);

    await svc.drainOnce();

    expect(updates).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no handler registered'));
    warn.mockRestore();
  });

  it('takes the oldest pending messages first', async () => {
    const { prisma } = makePrisma([]);
    await new OutboxService(prisma).drainOnce();
    expect(prisma.outboxMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } }),
    );
  });

  it('never runs two drains at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { prisma } = makePrisma([msg()]);
    const svc = new OutboxService(prisma);
    svc.register('email', async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
    });

    await Promise.all([svc.drain(), svc.drain(), svc.drain()]);
    expect(maxInFlight).toBe(1);
  });
});
