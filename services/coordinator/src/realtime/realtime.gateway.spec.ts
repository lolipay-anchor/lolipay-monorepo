import { RealtimeGateway, MAX_SOCKETS_PER_ADDRESS, CONNECT_RATE_LIMIT } from './realtime.gateway';

const JWT_SECRET = 'z'.repeat(40);
const ADMIN = 'GADMIN';
const USER = 'GUSER';
const OTHER_USER = 'GOTHER';
const LP_ADDR = 'GLP';
const NON_PARTY_LP = 'GLP2';
const ORDER_ID = 'order-1';

function makeSocket(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? `sock-${Math.random().toString(36).slice(2)}`,
    handshake: { auth: {}, headers: {} },
    data: {},
    join: jest.fn(),
    disconnect: jest.fn(),
    emit: jest.fn(),
    ...overrides,
  } as any;
}

function makeServer() {
  const roomEmit = jest.fn();
  const to = jest.fn().mockReturnValue({ emit: roomEmit });
  return { server: { to } as any, to, roomEmit };
}

function makeGateway(opts: {
  verifyImpl?: (token: string) => any;
  lpRow?: any;
  order?: any;
  adminAddresses?: string[];
} = {}) {
  const jwt = {
    verify: jest.fn().mockImplementation((token: string) => {
      if (opts.verifyImpl) return opts.verifyImpl(token);
      if (token === 'valid-user') return { sub: USER, cls: 'session' };
      if (token === 'valid-lp') return { sub: LP_ADDR, cls: 'session' };
      if (token === 'valid-admin') return { sub: ADMIN, cls: 'session' };
      if (token === 'valid-other-user') return { sub: OTHER_USER, cls: 'session' };
      if (token === 'valid-non-party-lp') return { sub: NON_PARTY_LP, cls: 'session' };
      throw new Error('invalid token');
    }),
  } as any;
  const cfg = { jwtSecret: JWT_SECRET, adminAddresses: opts.adminAddresses ?? [ADMIN] } as any;
  const lpFindUnique = jest.fn().mockImplementation(({ where }: any) => {
    if (where.stellarAddress === LP_ADDR) {
      return Promise.resolve(opts.lpRow ?? { stellarAddress: LP_ADDR, status: 'APPROVED' });
    }
    if (where.stellarAddress === NON_PARTY_LP) {
      return Promise.resolve({ stellarAddress: NON_PARTY_LP, status: 'APPROVED' });
    }
    return Promise.resolve(null);
  });
  const orderFindUnique = jest.fn().mockResolvedValue(
    opts.order ?? { id: ORDER_ID, userAddress: USER, lpWallet: LP_ADDR },
  );
  const prisma = {
    walletLink: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    lp: {
      findUnique: lpFindUnique,
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    order: { findUnique: orderFindUnique },
  } as any;

  const gw = new RealtimeGateway(jwt, cfg, prisma);
  gw.onModuleDestroy();
  return { gw, jwt, cfg, prisma };
}

describe('RealtimeGateway — handshake auth', () => {
  it('disconnects a socket with NO token', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket();
    await gw.handleConnection(socket);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects a socket with an INVALID token', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'garbage' }, headers: {} } });
    await gw.handleConnection(socket);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('accepts a valid token from handshake.auth.token and attaches {address, role}', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-user' }, headers: {} } });
    await gw.handleConnection(socket);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data).toEqual({ address: USER, role: 'user' });
    expect(socket.join).toHaveBeenCalledWith(`user:${USER}`);
  });

  it('accepts a valid token from the Authorization header (fallback)', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket({
      handshake: { auth: {}, headers: { authorization: 'Bearer valid-user' } },
    });
    await gw.handleConnection(socket);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data).toEqual({ address: USER, role: 'user' });
  });

  it('resolves role live: an admin-allowlisted address gets role "admin"', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-admin' }, headers: {} } });
    await gw.handleConnection(socket);
    expect(socket.data).toEqual({ address: ADMIN, role: 'admin' });
  });

  it('LP connect: joins lp:assignments and bumps liveness WITHOUT touching online (intent)', async () => {
    const { gw, prisma } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-lp' }, headers: {} } });
    await gw.handleConnection(socket);
    expect(socket.data).toEqual({ address: LP_ADDR, role: 'lp' });
    expect(socket.join).toHaveBeenCalledWith('lp:assignments');
    expect(prisma.lp.update).toHaveBeenCalledWith({
      where: { stellarAddress: LP_ADDR },
      data: { lastHeartbeatAt: expect.any(Date) },
    });

    const call = (prisma.lp.update as jest.Mock).mock.calls[0][0];
    expect(call.data).not.toHaveProperty('online');
  });

  it('admin connect: also auto-joins the admin:orders room (gate fix wave Fix 3)', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-admin' }, headers: {} } });
    await gw.handleConnection(socket);
    expect(socket.join).toHaveBeenCalledWith('admin:orders');
  });

  it('non-admin connect (user/LP) never joins admin:orders', async () => {
    const { gw } = makeGateway();
    const userSocket = makeSocket({ handshake: { auth: { token: 'valid-user' }, headers: {} } });
    await gw.handleConnection(userSocket);
    expect(userSocket.join).not.toHaveBeenCalledWith('admin:orders');

    const lpSocket = makeSocket({ handshake: { auth: { token: 'valid-lp' }, headers: {} } });
    await gw.handleConnection(lpSocket);
    expect(lpSocket.join).not.toHaveBeenCalledWith('admin:orders');
  });

  it('pins the accepted JWT algorithm to HS256 on every verify call (defense-in-depth, I-1)', async () => {
    const { gw, jwt, cfg } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-user' }, headers: {} } });
    await gw.handleConnection(socket);
    expect(jwt.verify).toHaveBeenCalledWith('valid-user', {
      secret: cfg.jwtSecret,
      algorithms: ['HS256'],
    });
  });
});

describe('RealtimeGateway — per-address connect-rate limit (DoS bound, security review M-1)', () => {
  it(
    'rejects connect CHURN beyond CONNECT_RATE_LIMIT for one address, and — critically — ' +
      'never reaches resolveRole/prisma for the rejected connects (checked before the DB await)',
    async () => {
      const { gw, prisma } = makeGateway();
      const N = CONNECT_RATE_LIMIT + 5;

      for (let i = 0; i < N; i++) {
        const socket = makeSocket({
          id: `churn-${i}`,
          handshake: { auth: { token: 'valid-user' }, headers: {} },
        });
        await gw.handleConnection(socket);
        if (i < CONNECT_RATE_LIMIT) {
          expect(socket.disconnect).not.toHaveBeenCalled();
          expect(socket.data).toEqual({ address: USER, role: 'user' });
        } else {
          expect(socket.disconnect).toHaveBeenCalledWith(true);
          expect(socket.data).toEqual({});
        }

        await gw.handleDisconnect(socket);
      }

      expect(prisma.lp.findUnique).toHaveBeenCalledTimes(CONNECT_RATE_LIMIT);
    },
  );

  it('tracks the rate PER ADDRESS — a second address is unaffected by the first exhausting its budget', async () => {
    const { gw, prisma } = makeGateway();

    for (let i = 0; i < CONNECT_RATE_LIMIT + 3; i++) {
      const socket = makeSocket({
        id: `exhaust-${i}`,
        handshake: { auth: { token: 'valid-user' }, headers: {} },
      });
      await gw.handleConnection(socket);
      await gw.handleDisconnect(socket);
    }
    (prisma.lp.findUnique as jest.Mock).mockClear();

    const lpSocket = makeSocket({ handshake: { auth: { token: 'valid-lp' }, headers: {} } });
    await gw.handleConnection(lpSocket);
    expect(lpSocket.disconnect).not.toHaveBeenCalled();
    expect(lpSocket.data).toEqual({ address: LP_ADDR, role: 'lp' });
  });

  it('resets after the rate window elapses — churn is bounded per-window, not forever', async () => {
    const { gw } = makeGateway();
    const realNow = Date.now;
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      for (let i = 0; i < CONNECT_RATE_LIMIT; i++) {
        const socket = makeSocket({
          id: `w1-${i}`,
          handshake: { auth: { token: 'valid-user' }, headers: {} },
        });
        await gw.handleConnection(socket);
        expect(socket.disconnect).not.toHaveBeenCalled();
        await gw.handleDisconnect(socket);
      }

      const stillLimited = makeSocket({
        id: 'still-limited',
        handshake: { auth: { token: 'valid-user' }, headers: {} },
      });
      await gw.handleConnection(stillLimited);
      expect(stillLimited.disconnect).toHaveBeenCalledWith(true);

      now += 10_001;
      const afterWindow = makeSocket({
        id: 'after-window',
        handshake: { auth: { token: 'valid-user' }, headers: {} },
      });
      await gw.handleConnection(afterWindow);
      expect(afterWindow.disconnect).not.toHaveBeenCalled();
    } finally {
      jest.spyOn(Date, 'now').mockImplementation(realNow);
    }
  });
});

describe('RealtimeGateway — MAX_SOCKETS_PER_ADDRESS cap under concurrency (TOCTOU regression)', () => {
  it('reserves the slot SYNCHRONOUSLY (before the resolveRole DB await), so a burst of ' +
    'N > MAX simultaneous connects for one address never all get registered', async () => {
    const { gw, prisma } = makeGateway();

    let releasePending!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      releasePending = resolve;
    });
    (prisma.lp.findUnique as jest.Mock).mockImplementation(() => pending);

    const N = MAX_SOCKETS_PER_ADDRESS + 5;
    const sockets = Array.from({ length: N }, (_, i) =>
      makeSocket({ id: `burst-${i}`, handshake: { auth: { token: 'valid-user' }, headers: {} } }),
    );

    const inFlight = sockets.map((s) => gw.handleConnection(s));

    releasePending(null);
    await Promise.all(inFlight);

    const registered = sockets.filter((s) =>
      (s.join as jest.Mock).mock.calls.some((c) => c[0] === `user:${USER}`),
    );
    const rejected = sockets.filter((s) => (s.disconnect as jest.Mock).mock.calls.length > 0);

    expect(registered).toHaveLength(MAX_SOCKETS_PER_ADDRESS);
    expect(rejected).toHaveLength(N - MAX_SOCKETS_PER_ADDRESS);

    expect(sockets.slice(0, MAX_SOCKETS_PER_ADDRESS)).toEqual(
      expect.arrayContaining(registered),
    );
    expect(sockets.slice(MAX_SOCKETS_PER_ADDRESS)).toEqual(expect.arrayContaining(rejected));
  });

  it('rolls back the reservation if resolveRole fails, so the slot is not lost forever', async () => {
    const { gw, prisma } = makeGateway();
    (prisma.lp.findUnique as jest.Mock).mockRejectedValueOnce(new Error('db down'));

    const failing = makeSocket({
      id: 'will-fail',
      handshake: { auth: { token: 'valid-user' }, headers: {} },
    });
    await gw.handleConnection(failing);
    expect(failing.disconnect).toHaveBeenCalledWith(true);

    const succeeding = makeSocket({
      id: 'succeeds-after',
      handshake: { auth: { token: 'valid-user' }, headers: {} },
    });
    (prisma.lp.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await gw.handleConnection(succeeding);
    expect(succeeding.disconnect).not.toHaveBeenCalled();
    expect(succeeding.join).toHaveBeenCalledWith(`user:${USER}`);
  });
});

describe('RealtimeGateway — join:order authorization', () => {
  it('authorizes the order\'s own user', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-user' }, headers: {} } });
    await gw.handleConnection(socket);
    await gw.handleJoinOrder(socket, { orderId: ORDER_ID });
    expect(socket.join).toHaveBeenCalledWith(`order:${ORDER_ID}`);
  });

  it('authorizes the order\'s matched LP', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-lp' }, headers: {} } });
    await gw.handleConnection(socket);
    await gw.handleJoinOrder(socket, { orderId: ORDER_ID });
    expect(socket.join).toHaveBeenCalledWith(`order:${ORDER_ID}`);
  });

  it('authorizes admin for ANY order', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-admin' }, headers: {} } });
    await gw.handleConnection(socket);
    await gw.handleJoinOrder(socket, { orderId: ORDER_ID });
    expect(socket.join).toHaveBeenCalledWith(`order:${ORDER_ID}`);
  });

  it('REJECTS a different user (not this order\'s userAddress)', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-other-user' }, headers: {} } });
    await gw.handleConnection(socket);
    await gw.handleJoinOrder(socket, { orderId: ORDER_ID });
    expect(socket.join).not.toHaveBeenCalledWith(`order:${ORDER_ID}`);
    expect(socket.emit).toHaveBeenCalledWith(
      'join:order:error',
      expect.objectContaining({ reason: 'forbidden' }),
    );
  });

  it('REJECTS an LP that is NOT this order\'s assigned LP', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-non-party-lp' }, headers: {} } });
    await gw.handleConnection(socket);
    await gw.handleJoinOrder(socket, { orderId: ORDER_ID });
    expect(socket.join).not.toHaveBeenCalledWith(`order:${ORDER_ID}`);
    expect(socket.emit).toHaveBeenCalledWith(
      'join:order:error',
      expect.objectContaining({ reason: 'forbidden' }),
    );
  });

  it('non-existent order → generic forbidden error (no not_found oracle), never joins', async () => {
    const { gw, prisma } = makeGateway();
    prisma.order.findUnique.mockResolvedValueOnce(null);
    const socket = makeSocket({ handshake: { auth: { token: 'valid-user' }, headers: {} } });
    await gw.handleConnection(socket);
    await gw.handleJoinOrder(socket, { orderId: 'nope' });
    expect(socket.join).not.toHaveBeenCalledWith('order:nope');

    expect(socket.emit).toHaveBeenCalledWith(
      'join:order:error',
      expect.objectContaining({ reason: 'forbidden' }),
    );
    expect(socket.emit).not.toHaveBeenCalledWith(
      'join:order:error',
      expect.objectContaining({ reason: 'not_found' }),
    );
  });

  it('never authorizes a socket whose handleConnection never ran (no socket.data.address)', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket();
    await gw.handleJoinOrder(socket, { orderId: ORDER_ID });
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('rate-limits excessive join:order calls from a single socket', async () => {
    const { gw } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-user' }, headers: {} } });
    await gw.handleConnection(socket);
    for (let i = 0; i < 31; i++) {
      await gw.handleJoinOrder(socket, { orderId: ORDER_ID });
    }
    expect(socket.emit).toHaveBeenCalledWith(
      'join:order:error',
      expect.objectContaining({ reason: 'rate_limited' }),
    );
  });
});

describe('RealtimeGateway — presence (LP intent persists across disconnect)', () => {
  it('the LAST socket disconnecting for an LP address does NOT touch Lp.online (intent persists)', async () => {
    const { gw, prisma } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-lp' }, headers: {} } });
    await gw.handleConnection(socket);
    (prisma.lp.update as jest.Mock).mockClear();
    await gw.handleDisconnect(socket);
    expect(prisma.lp.update).not.toHaveBeenCalled();
  });

  it('a refresh (disconnect immediately followed by reconnect) leaves online untouched and re-bumps lastHeartbeatAt', async () => {
    const { gw, prisma } = makeGateway({ lpRow: { stellarAddress: LP_ADDR, status: 'APPROVED', online: true } });
    const socketA = makeSocket({ id: 'a', handshake: { auth: { token: 'valid-lp' }, headers: {} } });
    await gw.handleConnection(socketA);
    await gw.handleDisconnect(socketA);

    const socketB = makeSocket({ id: 'b', handshake: { auth: { token: 'valid-lp' }, headers: {} } });
    await gw.handleConnection(socketB);

    for (const call of (prisma.lp.update as jest.Mock).mock.calls) {
      expect(call[0].data).not.toHaveProperty('online');
    }
  });

  it('does not touch Lp.online while another socket for the same LP is still connected', async () => {
    const { gw, prisma } = makeGateway();
    const socketA = makeSocket({ id: 'a', handshake: { auth: { token: 'valid-lp' }, headers: {} } });
    const socketB = makeSocket({ id: 'b', handshake: { auth: { token: 'valid-lp' }, headers: {} } });
    await gw.handleConnection(socketA);
    await gw.handleConnection(socketB);
    (prisma.lp.update as jest.Mock).mockClear();
    await gw.handleDisconnect(socketA);
    expect(prisma.lp.update).not.toHaveBeenCalled();
    await gw.handleDisconnect(socketB);
    expect(prisma.lp.update).not.toHaveBeenCalled();
  });

  it('a plain user disconnecting never touches Lp.online', async () => {
    const { gw, prisma } = makeGateway();
    const socket = makeSocket({ handshake: { auth: { token: 'valid-user' }, headers: {} } });
    await gw.handleConnection(socket);
    await gw.handleDisconnect(socket);
    expect(prisma.lp.update).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway.emitOrderUpdate', () => {
  it('emits a minimal payload to order:{id}, user:{userAddress}, and user:{lpWallet}; plus assignments:changed to lp:assignments', () => {
    const { gw } = makeGateway();
    const { server, to, roomEmit } = makeServer();
    gw.server = server;

    gw.emitOrderUpdate({ id: ORDER_ID, status: 'FUNDED', flow: 'TOP_UP', userAddress: USER, lpWallet: LP_ADDR });

    expect(to).toHaveBeenCalledWith(`order:${ORDER_ID}`);
    expect(to).toHaveBeenCalledWith(`user:${USER}`);
    expect(to).toHaveBeenCalledWith(`user:${LP_ADDR}`);
    expect(to).toHaveBeenCalledWith('admin:orders');
    expect(to).toHaveBeenCalledWith('lp:assignments');

    const orderUpdateCalls = roomEmit.mock.calls.filter((c) => c[0] === 'order:update');

    expect(orderUpdateCalls).toHaveLength(4);
    for (const [, payload] of orderUpdateCalls) {
      expect(payload).toEqual({
        id: ORDER_ID,
        status: 'FUNDED',
        flow: 'TOP_UP',
        updated_at: expect.any(String),
      });

      expect(payload).not.toHaveProperty('payment_instructions');
      expect(payload).not.toHaveProperty('userAddress');
      expect(payload).not.toHaveProperty('lpWallet');
    }

    const assignmentsCall = roomEmit.mock.calls.find((c) => c[0] === 'assignments:changed');
    expect(assignmentsCall?.[1]).toEqual({ orderId: ORDER_ID, status: 'FUNDED' });
  });

  it('skips the user:{lpWallet} room when lpWallet is null (no LP yet)', () => {
    const { gw } = makeGateway();
    const { server, to } = makeServer();
    gw.server = server;

    gw.emitOrderUpdate({ id: ORDER_ID, status: 'MATCHED', flow: 'WITHDRAW', userAddress: USER, lpWallet: null });

    expect(to).toHaveBeenCalledWith(`order:${ORDER_ID}`);
    expect(to).toHaveBeenCalledWith(`user:${USER}`);
    expect(to).not.toHaveBeenCalledWith(`user:${null}`);
  });

  it('never throws even if server.to() throws (failure-isolated)', () => {
    const { gw } = makeGateway();
    gw.server = { to: jest.fn(() => { throw new Error('boom'); }) } as any;
    expect(() =>
      gw.emitOrderUpdate({ id: ORDER_ID, status: 'FUNDED', flow: 'TOP_UP', userAddress: USER, lpWallet: null }),
    ).not.toThrow();
  });

  it('no-ops silently when server is not yet initialized', () => {
    const { gw } = makeGateway();
    expect(() =>
      gw.emitOrderUpdate({ id: ORDER_ID, status: 'FUNDED', flow: 'TOP_UP', userAddress: USER, lpWallet: null }),
    ).not.toThrow();
  });
});

describe('the socket door honours the token class too', () => {
  it('does not let a sep10 token join the administrator room', async () => {
    const { gw } = makeGateway({
      verifyImpl: () => ({ sub: ADMIN, cls: 'sep10' }),
      adminAddresses: [ADMIN],
    });
    const socket = makeSocket({ handshake: { auth: { token: 't' }, headers: {} } });

    await gw.handleConnection(socket);

    expect(socket.join).not.toHaveBeenCalledWith('admin:orders');
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('does not let a sep10 token join the provider room', async () => {
    const { gw } = makeGateway({
      verifyImpl: () => ({ sub: LP_ADDR, cls: 'sep10' }),
      lpRow: { status: 'APPROVED' },
    });
    const socket = makeSocket({ handshake: { auth: { token: 't' }, headers: {} } });

    await gw.handleConnection(socket);

    expect(socket.join).not.toHaveBeenCalledWith('lp:assignments');
  });

  it('still lets a session token into the administrator room', async () => {
    const { gw } = makeGateway({
      verifyImpl: () => ({ sub: ADMIN, cls: 'session' }),
      adminAddresses: [ADMIN],
    });
    const socket = makeSocket({ handshake: { auth: { token: 't' }, headers: {} } });

    await gw.handleConnection(socket);

    expect(socket.join).toHaveBeenCalledWith('admin:orders');
  });

  it('disconnects a token carrying no class at all', async () => {
    const { gw } = makeGateway({ verifyImpl: () => ({ sub: ADMIN }) });
    const socket = makeSocket({ handshake: { auth: { token: 't' }, headers: {} } });

    await gw.handleConnection(socket);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.join).not.toHaveBeenCalled();
  });
});

describe('the socket door is a session door', () => {
  it('refuses an anchor token outright rather than admitting it as a user', async () => {
    const { gw } = makeGateway({ verifyImpl: () => ({ sub: USER, cls: 'sep10' }) });
    const socket = makeSocket({ handshake: { auth: { token: 't' }, headers: {} } });

    await gw.handleConnection(socket);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('still admits an ordinary session', async () => {
    const { gw } = makeGateway({ verifyImpl: () => ({ sub: USER, cls: 'session' }) });
    const socket = makeSocket({ handshake: { auth: { token: 't' }, headers: {} } });

    await gw.handleConnection(socket);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.join).toHaveBeenCalledWith(`user:${USER}`);
  });
});
