import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  function make(withRealtime = false) {
    const prisma = {
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const enqueued: any[] = [];
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
    const outbox = { enqueue: jest.fn(async (_tx: any, job: any) => { enqueued.push(job); }) } as any;
    const people = { lookupPerson: jest.fn(async (a: string) => (a === 'GNOBODY' ? null : { id: `person-of-${a}` })) } as any;
    const realtime = withRealtime ? ({ emitOrderUpdate: jest.fn() } as any) : undefined;
    return { svc: new NotificationService(prisma, outbox, people, realtime), prisma, realtime, outbox, people, enqueued };
  }

  it('notifies BOTH parties on FUNDED, dedup via skipDuplicates', async () => {
    const { svc, prisma } = make();
    await svc.notifyOrderStatus(
      { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
      'FUNDED',
    );
    const arg = prisma.notification.createMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data.map((r: any) => r.address).sort()).toEqual(['GL', 'GU']);
    expect(arg.data.every((r: any) => r.event === 'FUNDED' && r.orderId === 'o1')).toBe(true);
    expect(arg.data.every((r: any) => r.title && r.body)).toBe(true);
  });

  it('does not create notifications for a status with no message (e.g. CREATED)', async () => {
    const { svc, prisma } = make();
    await svc.notifyOrderStatus(
      { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
      'CREATED',
    );
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('markAllRead flips the caller\'s unread notifications', async () => {
    const { svc, prisma } = make();
    await svc.markAllRead('GU');
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { address: 'GU', read: false },
      data: { read: true },
    });
  });

  it('MATCHED_EXPIRED: notifies BOTH parties, distinct event key from ACCEPTED_EXPIRED (no "exact bill" wording)', async () => {
    const { svc, prisma } = make();
    await svc.notifyOrderStatus(
      { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
      'MATCHED_EXPIRED',
    );
    const arg = prisma.notification.createMany.mock.calls[0][0];
    expect(arg.data).toHaveLength(2);
    expect(arg.data.map((r: any) => r.address).sort()).toEqual(['GL', 'GU']);
    expect(arg.data.every((r: any) => r.event === 'MATCHED_EXPIRED')).toBe(true);
    expect(arg.data.every((r: any) => !r.body.includes('exact bill'))).toBe(true);
  });

  it('MATCHED_EXPIRED: user and LP get DIFFERENT, role-appropriate copy (not identical text)', async () => {
    const { svc, prisma } = make();
    await svc.notifyOrderStatus(
      { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
      'MATCHED_EXPIRED',
    );
    const arg = prisma.notification.createMany.mock.calls[0][0];
    const userRow = arg.data.find((r: any) => r.address === 'GU');
    const lpRow = arg.data.find((r: any) => r.address === 'GL');
    expect(userRow.body).not.toEqual(lpRow.body);
    expect(userRow.body.toLowerCase()).toContain('your order');
    expect(lpRow.body.toLowerCase()).toContain('assigned');
  });

  it('CANCELLED: no in-app notification message (deliberately, not a "you lost" event) but realtime still emits', async () => {
    const { svc, prisma, realtime } = make(true);
    await svc.notifyOrderStatus(
      { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
      'CANCELLED',
    );
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(realtime.emitOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1', status: 'CANCELLED' }),
    );
  });

  it('DISPUTED with settledAt null (pre-settlement, FIAT_PAID → DISPUTED) → the normal dispute message', async () => {
    const { svc, prisma } = make();
    await svc.notifyOrderStatus(
      { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP', settledAt: null },
      'DISPUTED',
    );
    const arg = prisma.notification.createMany.mock.calls[0][0];
    expect(arg.data).toHaveLength(2);
    expect(arg.data.every((r: any) => r.title === 'Dispute opened')).toBe(true);
  });

  it('DISPUTED with settledAt present (post-settlement dispute) → a distinct message', async () => {
    const { svc, prisma } = make();
    await svc.notifyOrderStatus(
      {
        id: 'o1',
        userAddress: 'GU',
        lpWallet: 'GL',
        flow: 'TOP_UP',
        settledAt: new Date(Date.now() - 60_000),
      },
      'DISPUTED',
    );
    const arg = prisma.notification.createMany.mock.calls[0][0];
    expect(arg.data).toHaveLength(2);
    expect(arg.data.every((r: any) => r.title === 'Post-settlement dispute opened')).toBe(true);
  });

  it('DISPUTED with no settledAt field at all (omitted, not just null) → falls back to the normal dispute message, no crash', async () => {
    const { svc, prisma } = make();
    await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' }, 'DISPUTED');
    const arg = prisma.notification.createMany.mock.calls[0][0];
    expect(arg.data.every((r: any) => r.title === 'Dispute opened')).toBe(true);
  });

  describe('realtime emit', () => {
    it('calls realtime.emitOrderUpdate with {id, status, flow, userAddress, lpWallet} AFTER the DB write, using the NEW status', async () => {
      const { svc, prisma, realtime } = make(true);
      await svc.notifyOrderStatus(
        { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
        'FUNDED',
      );

      expect(prisma.notification.createMany).toHaveBeenCalled();
      expect(realtime.emitOrderUpdate).toHaveBeenCalledWith({
        id: 'o1',
        status: 'FUNDED',
        flow: 'TOP_UP',
        userAddress: 'GU',
        lpWallet: 'GL',
      });
      const createManyOrder = prisma.notification.createMany.mock.invocationCallOrder[0];
      const emitOrder = realtime.emitOrderUpdate.mock.invocationCallOrder[0];
      expect(createManyOrder).toBeLessThan(emitOrder);
    });

    it('still emits even for a transition with no in-app message (e.g. CREATED — no createMany call)', async () => {
      const { svc, realtime } = make(true);
      await svc.notifyOrderStatus(
        { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
        'CREATED',
      );
      expect(realtime.emitOrderUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'o1', status: 'CREATED' }),
      );
    });

    it('never throws when realtime is omitted (optional dep, back-compat 1-arg construction)', async () => {
      const { svc } = make(false);
      await expect(
        svc.notifyOrderStatus(
          { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
          'FUNDED',
        ),
      ).resolves.toBeUndefined();
    });
  });
  describe('the email side of a notification', () => {
    it('queues one email per notification row, carrying a personId and never an address', async () => {
      const { svc, enqueued } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' }, 'FUNDED');

      expect(enqueued).toHaveLength(2);
      for (const job of enqueued) {
        expect(job.kind).toBe('email');
        expect(job.payload.personId).toMatch(/^person-of-/);
        expect(Object.keys(job.payload).sort()).toEqual(['personId', 'subject', 'text']);
        expect(job.payload.subject).toBeTruthy();
        expect(job.payload.text).toBeTruthy();
      }
    });

    it('queues the email in the same transaction as the notification row, so a crash cannot write one without the other', async () => {
      const { svc, prisma, outbox } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' }, 'FUNDED');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const tx = (outbox.enqueue.mock.calls as any[])[0][0];
      expect(tx).toBe(prisma);
    });

    it('gives every email a dedupe key of order, status and recipient, so a replayed status cannot send twice', async () => {
      const { svc, enqueued } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' }, 'FUNDED');

      const keys = enqueued.map((j) => j.dedupeKey);
      expect(new Set(keys).size).toBe(2);
      for (const k of keys) expect(k).toMatch(/^email:o1:FUNDED:person-of-G[UL]$/);
    });

    it('queues nothing for a recipient with no person, rather than an undeliverable row', async () => {
      const { svc, enqueued } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GNOBODY', lpWallet: 'GL', flow: 'TOP_UP' }, 'FUNDED');

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0].payload.personId).toBe('person-of-GL');
    });

    it('queues nothing at all when the status produces no notification', async () => {
      const { svc, enqueued, prisma } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' }, 'CANCELLED');

      expect(prisma.notification.createMany).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(0);
    });
  });
});
