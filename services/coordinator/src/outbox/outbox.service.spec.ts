import { Logger } from '@nestjs/common';
import { OutboxService, OUTBOX_MAX_ATTEMPTS, OUTBOX_BACKOFF_CAP_MS, backoffFor } from './outbox.service';

function makePrisma(pending: any[] = []) {
  const updates: any[] = [];
  const created: any[] = [];
  const prisma: any = {
    outboxMessage: {
      create: jest.fn(async ({ data }: any) => { created.push(data); return data; }),
      createMany: jest.fn(async ({ data }: any) => { created.push(...data); return { count: data.length }; }),
      findMany: jest.fn(async () => pending),
      updateMany: jest.fn(async (args: any) => { updates.push(args); return { count: 1 }; }),
      deleteMany: jest.fn(async () => ({ count: 3 })),
      count: jest.fn(async () => 0),
    },
  };
  return { prisma, updates, created };
}

const msg = (over: any = {}) => ({
  id: 'm1', kind: 'email', payload: { to: 'a@b.c' }, attempts: 0, status: 'PENDING',
  nextAttemptAt: new Date(0), ...over,
});

describe('OutboxService.enqueue', () => {
  it('writes through the transaction client it is handed, not its own', async () => {
    const { prisma } = makePrisma();
    const svc = new OutboxService(prisma);
    const tx = { outboxMessage: { createMany: jest.fn(async () => ({ count: 1 })) } };

    await svc.enqueue(tx as any, { kind: 'email', payload: { a: 1 } });

    expect(tx.outboxMessage.createMany).toHaveBeenCalled();
    expect(prisma.outboxMessage.createMany).not.toHaveBeenCalled();
  });

  it('lets the database resolve a duplicate, because a caught one aborts the caller transaction', async () => {
    const svc = new OutboxService(makePrisma().prisma);
    const createMany = jest.fn(async () => ({ count: 0 }));
    const tx = { outboxMessage: { createMany } };

    await expect(
      svc.enqueue(tx as any, { kind: 'email', payload: {}, dedupeKey: 'k' }),
    ).resolves.toBeUndefined();

    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it('no longer swallows P2002, because a swallowed one hides an aborted transaction', async () => {
    const svc = new OutboxService(makePrisma().prisma);
    const tx = {
      outboxMessage: {
        createMany: jest.fn(async () => {
          const e: any = new Error('dup');
          e.code = 'P2002';
          throw e;
        }),
      },
    };
    await expect(
      svc.enqueue(tx as any, { kind: 'email', payload: {}, dedupeKey: 'k' }),
    ).rejects.toThrow('dup');
  });

  it('still surfaces a real database error', async () => {
    const svc = new OutboxService(makePrisma().prisma);
    const tx = { outboxMessage: { createMany: jest.fn(async () => { throw new Error('disk full'); }) } };
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

  it('counts an attempt against a message whose kind has no handler', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { prisma, updates } = makePrisma([msg({ kind: 'unregistered' })]);
    const svc = new OutboxService(prisma);

    await svc.drainOnce();

    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({ attempts: 1, status: 'PENDING' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no handler registered'));
    warn.mockRestore();
  });

  it('gives up on an unhandled kind rather than letting it hold the head of the queue', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { prisma, updates } = makePrisma([
      msg({ kind: 'unregistered', attempts: OUTBOX_MAX_ATTEMPTS - 1 }),
    ]);

    await new OutboxService(prisma).drainOnce();

    expect(updates[0].data).toMatchObject({ attempts: OUTBOX_MAX_ATTEMPTS, status: 'FAILED' });
    warn.mockRestore();
  });

  it('takes only messages whose next attempt is due, soonest first', async () => {
    const { prisma } = makePrisma([]);
    await new OutboxService(prisma).drainOnce();
    const args = prisma.outboxMessage.findMany.mock.calls[0][0];
    expect(args.where.status).toBe('PENDING');
    expect(args.where.nextAttemptAt.lte).toBeInstanceOf(Date);
    expect(args.orderBy).toEqual([{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }]);
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

describe('a failed delivery waits longer each time', () => {
  it('spaces retries out instead of burning five in two minutes', () => {
    expect(backoffFor(1)).toBe(30_000);
    expect(backoffFor(2)).toBe(60_000);
    expect(backoffFor(3)).toBe(120_000);
    expect(backoffFor(4)).toBe(240_000);
  });

  it('stops growing at half an hour, so a long outage still gets tries', () => {
    expect(backoffFor(20)).toBe(OUTBOX_BACKOFF_CAP_MS);
  });

  it('gives a whole day of retries before it gives up, not two minutes', () => {
    let total = 0;
    for (let a = 1; a < OUTBOX_MAX_ATTEMPTS; a += 1) total += backoffFor(a);
    expect(total).toBeGreaterThan(7 * 60 * 1000);
  });

  it('pushes the next attempt into the future when a delivery fails', async () => {
    const { prisma, updates } = makePrisma([msg()]);
    const svc = new OutboxService(prisma);
    svc.register('email', async () => { throw new Error('boom'); });
    await svc.drainOnce();
    expect(updates[0].data.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('the queue does not keep what it has delivered forever', () => {
  it('removes delivered messages past the retention window and nothing else', async () => {
    const { prisma } = makePrisma([]);
    await new OutboxService(prisma).prune(new Date('2026-08-26T00:00:00Z'));
    const where = prisma.outboxMessage.deleteMany.mock.calls[0][0].where;
    expect(where.status).toBe('SENT');
    expect(where.sentAt.lt).toEqual(new Date('2026-08-12T00:00:00Z'));
  });

  it('counts what gave up and what is stuck, so the failure record is not write-only', async () => {
    const { prisma } = makePrisma([]);
    prisma.outboxMessage.count = jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const counts = await new OutboxService(prisma).stuckCounts();
    expect(counts).toEqual({ failed: 2, stalled: 1 });
  });
});
