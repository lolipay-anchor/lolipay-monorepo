import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  function make(
    withRealtime = false,
    lpRows: Record<string, { stellarAddress: string; alertEmail: string | null }> = {},
  ) {
    const byId = new Map(Object.entries(lpRows).map(([id, r]) => [id, { id, ...r }]));
    const byAddress = new Map([...byId.values()].map((r) => [r.stellarAddress, r]));
    const prisma = {
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      lp: {
        findUnique: jest.fn(async ({ where }: any) => (where?.id ? byId.get(where.id) ?? null : null)),
        findFirst: jest.fn(async ({ where }: any) =>
          where?.id ? byId.get(where.id) ?? null : where?.stellarAddress ? byAddress.get(where.stellarAddress) ?? null : null,
        ),
      },
    } as any;
    const enqueued: any[] = [];
    prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
    const outbox = { enqueue: jest.fn(async (_tx: any, job: any) => { enqueued.push(job); }) } as any;
    const people = {
      lookupPerson: jest.fn(async (a: string) =>
        a === 'GNOBODY' ? null : { id: `person-of-${a}`, email: a === 'GNOMAIL' ? null : `${a.toLowerCase()}@example.test` },
      ),
    } as any;
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

  describe('markAllRead is scoped to what list() would actually show', () => {
    function row(id: string, address: string, createdAt: number, read = false) {
      return { id, address, orderId: null, event: 'x', title: 't', body: 'b', read, createdAt };
    }

    function makeStateful() {
      const rows: any[] = [];
      const prisma = {
        notification: {
          findMany: jest.fn(async (args: any) => {
            let result = rows.filter((r) => r.address === args.where.address);
            if (args.where.read !== undefined) {
              result = result.filter((r) => r.read === args.where.read);
            }
            result = [...result].sort((a, b) =>
              b.createdAt !== a.createdAt ? b.createdAt - a.createdAt : b.id.localeCompare(a.id),
            );
            if (args.take !== undefined) result = result.slice(0, args.take);
            return args.select ? result.map((r) => ({ id: r.id })) : result;
          }),
          updateMany: jest.fn(async (args: any) => {
            const ids: string[] = args.where.id?.in ?? [];
            let count = 0;
            for (const r of rows) {
              if (ids.includes(r.id) && (args.where.read === undefined || r.read === args.where.read)) {
                Object.assign(r, args.data);
                count++;
              }
            }
            return { count };
          }),
        },
      } as any;
      const svc = new NotificationService(prisma, {} as any, {} as any, undefined);
      return {
        svc,
        prisma,
        seed: (newRows: any[]) => rows.push(...newRows),
        rowsFor: (address: string) => rows.filter((r) => r.address === address),
      };
    }

    it('marks every unread row read when there are fewer than the page size (the caller\'s unread notifications are flipped)', async () => {
      const { svc, seed, rowsFor } = makeStateful();
      seed([row('a', 'GU', 3), row('b', 'GU', 2), row('c', 'GU', 1)]);
      await svc.markAllRead('GU');
      expect(rowsFor('GU').every((r) => r.read)).toBe(true);
    });

    it('leaves rows beyond the shown page unread — the bug this fixes', async () => {
      const { svc, seed, rowsFor } = makeStateful();
      const seeded = Array.from({ length: 60 }, (_, i) => row(`r${i}`, 'GU', 60 - i));
      expect(seeded).toHaveLength(60);
      seed(seeded);
      await svc.markAllRead('GU');
      const sorted = rowsFor('GU').sort((a, b) => b.createdAt - a.createdAt);
      expect(sorted.slice(0, 50).every((r) => r.read)).toBe(true);
      expect(sorted.slice(50).every((r) => !r.read)).toBe(true);
    });

    it('does not reach past the page even when older rows are unread and newer ones are already read', async () => {
      const { svc, seed, rowsFor } = makeStateful();
      const seeded = [
        ...Array.from({ length: 10 }, (_, i) => row(`read${i}`, 'GU', 100 - i, true)),
        ...Array.from({ length: 40 }, (_, i) => row(`shown${i}`, 'GU', 90 - i, false)),
        ...Array.from({ length: 10 }, (_, i) => row(`unseen${i}`, 'GU', 50 - i, false)),
      ];
      expect(seeded).toHaveLength(60);
      seed(seeded);
      await svc.markAllRead('GU');
      expect(rowsFor('GU').filter((r) => r.id.startsWith('unseen')).every((r) => !r.read)).toBe(true);
      expect(rowsFor('GU').filter((r) => r.id.startsWith('shown')).every((r) => r.read)).toBe(true);
    });

    it('queries the exact same window as list() — same where, same order, same take — so a tie between the two can never be broken two different ways', async () => {
      const { svc, seed, prisma } = makeStateful();
      seed([row('a', 'GU', 1)]);
      await svc.list('GU');
      await svc.markAllRead('GU');
      const [listArgs, markArgs] = prisma.notification.findMany.mock.calls.map((c: any) => c[0]);
      expect(markArgs.where).toEqual(listArgs.where);
      expect(markArgs.orderBy).toEqual(listArgs.orderBy);
      expect(markArgs.take).toBe(listArgs.take);
    });

    it('touches no other caller\'s rows', async () => {
      const { svc, seed, rowsFor } = makeStateful();
      seed([row('mine', 'GU', 2), row('theirs', 'GL', 1)]);
      await svc.markAllRead('GU');
      expect(rowsFor('GL').every((r) => !r.read)).toBe(true);
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

  describe('MATCHED_EXPIRED: the LP branch depends on whether ADR 0053\'s presence penalty just fired', () => {
    it('no penalty attached: the assignment is closed, and a late transaction still reopens it', async () => {
      const { svc, prisma } = make();
      await svc.notifyOrderStatus(
        { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
        'MATCHED_EXPIRED',
      );
      const rows = prisma.notification.createMany.mock.calls[0][0].data;
      const lp = rows.find((r: any) => r.address === 'GL');
      expect(lp.body).toBe(
        'The order assigned to you was not completed on-chain in time and the assignment has been closed. If your transaction reaches the network after this, the order will reopen and you will be told.',
      );
    });

    it('penalty attached: the provider is told the assignment expiring just set them unavailable, and that a late transaction still reopens the order', async () => {
      const { svc, prisma } = make();
      await (svc as any).notifyOrderStatus(
        { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
        'MATCHED_EXPIRED',
        true,
      );
      const rows = prisma.notification.createMany.mock.calls[0][0].data;
      const lp = rows.find((r: any) => r.address === 'GL');
      expect(lp.title).toBe('Assignment expired — you have been set unavailable');
      expect(lp.body).toBe(
        'The order assigned to you was not completed on-chain in time, so this anchor has set you unavailable and you will not be assigned new orders. Set yourself available again on your dashboard, where the readiness list shows your stake and payment method. If your transaction reaches the network after this, the order will reopen and you will be told.',
      );
    });
  });

  describe('MATCHED — the provider is told an order was assigned, instead of being expected to watch a screen', () => {
    const PAY_DEADLINE = 1_800_000_000n;

    it('TOP_UP: the provider gets the assignment and the moment after which this anchor stops building the funding transaction', async () => {
      const { svc, prisma } = make();
      await svc.notifyOrderStatus(
        { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP', payDeadline: PAY_DEADLINE },
        'MATCHED',
      );

      const arg = prisma.notification.createMany.mock.calls[0][0];
      expect(arg.data).toHaveLength(1);
      expect(arg.data[0].address).toBe('GL');
      expect(arg.data[0].event).toBe('MATCHED');
      expect(arg.data[0].title).toBe('New order — lock the USDC');
      expect(arg.data[0].body).toBe(
        'An order has been assigned to you. Lock the USDC in escrow before 2027-01-15T07:49:00.000Z or the assignment expires.',
      );
    });

    it('TOP_UP with no pay deadline on the row: still tells the provider, and names no time it cannot stand behind', async () => {
      const { svc, prisma } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' }, 'MATCHED');

      const arg = prisma.notification.createMany.mock.calls[0][0];
      expect(arg.data).toHaveLength(1);
      expect(arg.data[0].body).toBe(
        'An order has been assigned to you. Lock the USDC in escrow before the assignment expires.',
      );
    });

    it('WITHDRAW: the provider is NOT told to lock USDC — on this flow the seller locks it, and the provider owes nothing yet', async () => {
      const { svc, prisma } = make();
      await svc.notifyOrderStatus(
        { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'WITHDRAW', payDeadline: PAY_DEADLINE },
        'MATCHED',
      );

      const arg = prisma.notification.createMany.mock.calls[0][0];
      expect(arg.data).toHaveLength(1);
      expect(arg.data[0].address).toBe('GL');
      expect(arg.data[0].title).toBe('New order assigned');
      expect(arg.data[0].body).toBe(
        'An order has been assigned to you. The seller locks their USDC first — nothing is needed from you yet.',
      );
    });

    it('the user who just placed the order is not emailed on either flow — only the provider is', async () => {
      for (const flow of ['TOP_UP', 'WITHDRAW']) {
        const { svc, prisma, enqueued } = make();
        await svc.notifyOrderStatus(
          { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow, payDeadline: PAY_DEADLINE },
          'MATCHED',
        );

        const arg = prisma.notification.createMany.mock.calls[0][0];
        expect(arg.data.map((r: any) => r.address)).toEqual(['GL']);
        expect(enqueued.map((j) => j.payload.personId)).toEqual(['person-of-GL']);
      }
    });

    it('queues exactly one email, keyed so a replayed MATCHED cannot send twice', async () => {
      const { svc, enqueued } = make();
      await svc.notifyOrderStatus(
        { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP', payDeadline: PAY_DEADLINE },
        'MATCHED',
      );

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0].dedupeKey).toBe('email:o1:MATCHED:person-of-GL');
    });

    it('emits the realtime update too, so an open LP tab moves without waiting for a poll', async () => {
      const { svc, realtime } = make(true);
      await svc.notifyOrderStatus(
        { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP', payDeadline: PAY_DEADLINE },
        'MATCHED',
      );

      expect(realtime.emitOrderUpdate).toHaveBeenCalledWith({
        id: 'o1',
        status: 'MATCHED',
        flow: 'TOP_UP',
        userAddress: 'GU',
        lpWallet: 'GL',
      });
    });
  });

  it('CANCELLED: BOTH parties are told, and realtime still emits', async () => {
    const { svc, prisma, realtime } = make(true);
    await svc.notifyOrderStatus(
      { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
      'CANCELLED',
    );
    const arg = prisma.notification.createMany.mock.calls[0][0];
    expect(arg.data).toHaveLength(2);
    expect(arg.data.map((r: any) => r.address).sort()).toEqual(['GL', 'GU']);
    expect(arg.data.every((r: any) => r.event === 'CANCELLED' && r.orderId === 'o1')).toBe(true);
    expect(arg.data.every((r: any) => r.title && r.body)).toBe(true);
    expect(realtime.emitOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o1', status: 'CANCELLED' }),
    );
  });

  it('CANCELLED: the provider is told, because the MATCHED message told them to lock USDC and funding a cancelled order revives it — and, since ADR 0053\'s presence penalty can take a provider offline on a DIFFERENT order, no longer promises they are free to accept other orders', async () => {
    const { svc, prisma } = make();
    await svc.notifyOrderStatus(
      { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
      'CANCELLED',
    );
    const rows = prisma.notification.createMany.mock.calls[0][0].data;
    const user = rows.find((r: any) => r.address === 'GU');
    const lp = rows.find((r: any) => r.address === 'GL');
    expect(user.body).not.toEqual(lp.body);
    expect(lp.body).not.toMatch(/free to accept other orders/);
  });

  it('CANCELLED: the provider is told the pinned sentence verbatim, for BOTH flows — no flow branch (product-strategist, 2026-09-22)', async () => {
    const bodies = new Set<string>();
    for (const flow of ['TOP_UP', 'WITHDRAW']) {
      const { svc, prisma } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow }, 'CANCELLED');
      const rows = prisma.notification.createMany.mock.calls[0][0].data;
      bodies.add(rows.find((r: any) => r.address === 'GL').body);
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toBe(
      'The order assigned to you was cancelled before anything was locked on chain, so nothing is needed from you. If your transaction reaches the network after this, the order will reopen and you will be told.',
    );
  });

  it('CANCELLED: neither message names who cancelled — either party may cancel and messageFor is never told which', async () => {
    const { svc, prisma } = make();
    await svc.notifyOrderStatus(
      { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' },
      'CANCELLED',
    );
    const rows = prisma.notification.createMany.mock.calls[0][0].data;
    for (const r of rows) {
      expect(`${r.title} ${r.body}`).not.toMatch(/you cancelled|buyer cancelled|seller cancelled|merchant cancelled|cancelled by/i);
    }
  });

  it('CANCELLED before any provider was matched: exactly one row, the user\'s — nobody is invented to notify', async () => {
    const { svc, prisma } = make();
    await svc.notifyOrderStatus(
      { id: 'o1', userAddress: 'GU', lpWallet: null, flow: 'TOP_UP' },
      'CANCELLED',
    );
    const rows = prisma.notification.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe('GU');
  });

  it('CANCELLED: the copy never promises the money is untouched — a cancelled order can still hold escrow (maintenance auto-refunds it) and can revive to FUNDED', async () => {
    const { svc, prisma } = make();
    for (const flow of ['TOP_UP', 'WITHDRAW']) {
      prisma.notification.createMany.mockClear();
      await svc.notifyOrderStatus(
        { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow },
        'CANCELLED',
      );
      const rows = prisma.notification.createMany.mock.calls[0][0].data;
      for (const r of rows) {
        expect(`${r.title} ${r.body}`).not.toMatch(
          /nothing (was|is) (locked|taken)|nothing to refund|no longer active|has been refunded/i,
        );
      }
    }
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

  describe('REFUNDED: the sentence names who the escrow actually paid, per order.params.ts mapRoles', () => {
    it('TOP_UP/user: the depositor is told the USDC went back to the merchant', async () => {
      const { svc, prisma } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' }, 'REFUNDED');
      const rows = prisma.notification.createMany.mock.calls[0][0].data;
      expect(rows.find((r: any) => r.address === 'GU').body).toBe(
        'The USDC was returned to the merchant. You were not charged, and you can still open a dispute on this order for a short time.',
      );
    });

    it('TOP_UP/lp: the provider who locked the USDC is told it came back to their own wallet, and that a dispute is still open', async () => {
      const { svc, prisma } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' }, 'REFUNDED');
      const rows = prisma.notification.createMany.mock.calls[0][0].data;
      expect(rows.find((r: any) => r.address === 'GL').body).toBe(
        'The USDC you locked was returned to your wallet in full. You can still open a dispute on this order for a short time.',
      );
    });

    it('WITHDRAW/user: the depositor who locked the USDC to sell it is told it came back to their own wallet', async () => {
      const { svc, prisma } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'WITHDRAW' }, 'REFUNDED');
      const rows = prisma.notification.createMany.mock.calls[0][0].data;
      expect(rows.find((r: any) => r.address === 'GU').body).toBe(
        'Your USDC was returned to your wallet in full. You can still open a dispute on this order for a short time.',
      );
    });

    it('WITHDRAW/lp: the provider who never locked anything is told it went to the seller, not to them, and that a dispute is still open if the rupiah was already sent', async () => {
      const { svc, prisma } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'WITHDRAW' }, 'REFUNDED');
      const rows = prisma.notification.createMany.mock.calls[0][0].data;
      expect(rows.find((r: any) => r.address === 'GL').body).toBe(
        'The USDC was returned to the seller and it did not come to you. If you already sent the rupiah for this order, open a dispute from your assignments now — the window to do it is short.',
      );
    });
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
        const keys = Object.keys(job.payload).sort();
        expect(keys).toEqual(expect.arrayContaining(['personId', 'subject', 'text']));
        expect(keys.every((k) => ['lpId', 'personId', 'subject', 'text'].includes(k))).toBe(true);
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

    it('queues nothing for a recipient whose person has no address, while still writing them the in-app row', async () => {
      const { svc, enqueued, prisma } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GNOMAIL', flow: 'TOP_UP' }, 'FUNDED');

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0].payload.personId).toBe('person-of-GU');
      expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: any) => r.address).sort()).toEqual([
        'GNOMAIL',
        'GU',
      ]);
    });

    it('queues nothing at all when the status produces no notification', async () => {
      const { svc, enqueued, prisma } = make();
      await svc.notifyOrderStatus({ id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP' }, 'CREATED');

      expect(prisma.notification.createMany).not.toHaveBeenCalled();
      expect(enqueued).toHaveLength(0);
    });
  });

  describe('ADR 0054 — a provider reachable by Lp.alertEmail alone still gets an OutboxMessage', () => {
    it('6 — a provider reachable only by alertEmail (its Person.email NULL) produces an OutboxMessage', async () => {
      const order = { id: 'o1', userAddress: 'GU', lpWallet: 'GNOMAIL', flow: 'TOP_UP', lpId: 'lp1' };
      const { svc, enqueued } = make(false, { lp1: { stellarAddress: 'GNOMAIL', alertEmail: 'ops@example.com' } });
      await svc.notifyOrderStatus(order, 'FUNDED');

      expect(enqueued.some((j) => j.payload.lpId === 'lp1')).toBe(true);
    });

    it('7 — a provider with no Person at all (personId null) but alertEmail on file still enqueues, and the dedupeKey is well-formed', async () => {
      const order = { id: 'o1', userAddress: 'GU', lpWallet: 'GNOBODY', flow: 'TOP_UP', lpId: 'lp1' };
      const { svc, enqueued } = make(false, { lp1: { stellarAddress: 'GNOBODY', alertEmail: 'ops@example.com' } });

      await expect(svc.notifyOrderStatus(order, 'FUNDED')).resolves.toBeUndefined();

      const job = enqueued.find((j) => j.payload.lpId === 'lp1');
      expect(job).toBeDefined();
      expect(job!.dedupeKey).toMatch(/^email:o1:FUNDED:.+$/);
      expect(job!.dedupeKey).not.toMatch(/undefined|null/);
    });

    it("8 — the lp job payload carries lpId (edit 3) and personId: null, reachable ONLY by alertEmail now that Person.email is not a provider reachability path", async () => {
      const order = { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP', lpId: 'lp1' };
      const { svc, enqueued } = make(false, { lp1: { stellarAddress: 'GL', alertEmail: 'ops@example.com' } });
      await svc.notifyOrderStatus(order, 'FUNDED');

      const job = enqueued.find((j) => j.payload.lpId === 'lp1');
      expect(job).toBeDefined();
      expect(job!.payload.lpId).toBe('lp1');
      expect(job!.payload.personId).toBeNull();
    });

    it("9 — the enqueue gate is narrowed for the lp row only: no job for a provider unreachable by alertEmail, even though a Person.email is linked, while the depositor's own job on the SAME shared gate still enqueues via Person.email", async () => {
      const order = { id: 'o1', userAddress: 'GU', lpWallet: 'GL', flow: 'TOP_UP', lpId: 'lp1' };
      const { svc, enqueued } = make(false, { lp1: { stellarAddress: 'GL', alertEmail: null } });
      await svc.notifyOrderStatus(order, 'FUNDED');

      expect(enqueued.some((j) => j.payload.lpId === 'lp1')).toBe(false);
      expect(enqueued.some((j) => j.payload.personId === 'person-of-GU')).toBe(true);
    });
  });
});
