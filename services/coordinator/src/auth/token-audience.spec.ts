import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { jwtVerifyOptions } from './jwt-options';
import { RealtimeGateway } from '../realtime/realtime.gateway';

const SECRET = 'a'.repeat(32);

function makeCfg() {
  return {
    jwtSecret: SECRET,
    jwtTtl: 900,
    challengeTtl: 300,
    jwtIssuer: 'https://lolipay.app',
    jwtAudience: 'lolipay-app',
    adminAddresses: [] as string[],
  } as any;
}

function makePrisma() {
  return {
    walletLink: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    lp: { findUnique: jest.fn().mockResolvedValue(null) },
  } as any;
}

function makeSocket() {
  return {
    id: 's1',
    handshake: { auth: { token: '' }, headers: {} },
    data: {} as any,
    join: jest.fn(),
    disconnect: jest.fn(),
    emit: jest.fn(),
    on: jest.fn(),
  } as any;
}

function tokenWith(overrides: { issuer?: string; audience?: string }) {
  const cfg = makeCfg();
  return new JwtService({ secret: SECRET }).sign(
    { sub: 'GUSER', cls: 'session' },
    {
      issuer: overrides.issuer ?? cfg.jwtIssuer,
      audience: overrides.audience ?? cfg.jwtAudience,
    },
  );
}

describe('a token minted for somewhere else is not a token here', () => {
  it('stamps the issuer and the audience on every token it mints', async () => {
    const jwt = { signAsync: jest.fn().mockResolvedValue('t') } as any;
    const svc = new AuthService(jwt, makeCfg(), makePrisma(), {
      proveWallet: jest.fn().mockResolvedValue({ id: 'p1' }),
    } as any);

    await (svc as any).mintFor('GUSER');

    expect(jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'GUSER', cls: 'session' }),
      expect.objectContaining({ issuer: 'https://lolipay.app', audience: 'lolipay-app' }),
    );
  });

  it('both doors verify against the same issuer and audience', () => {
    const opts = jwtVerifyOptions(makeCfg());

    expect(opts.issuer).toBe('https://lolipay.app');
    expect(opts.audience).toBe('lolipay-app');
    expect(opts.algorithms).toEqual(['HS256']);
  });

  it.each([
    ['a foreign audience', { audience: 'somebody-elses-app' }],
    ['a foreign issuer', { issuer: 'some-other-service' }],
  ])('the socket door refuses a token with %s, even signed with our secret', async (_name, o) => {
    const gw = new RealtimeGateway(new JwtService({ secret: SECRET }), makeCfg(), makePrisma());
    const socket = makeSocket();
    socket.handshake.auth.token = tokenWith(o);

    await gw.handleConnection(socket);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.join).not.toHaveBeenCalled();
  });

  it('the socket door still accepts our own token', async () => {
    const gw = new RealtimeGateway(new JwtService({ secret: SECRET }), makeCfg(), makePrisma());
    const socket = makeSocket();
    socket.handshake.auth.token = tokenWith({});

    await gw.handleConnection(socket);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.join).toHaveBeenCalledWith('user:GUSER');
  });
});
