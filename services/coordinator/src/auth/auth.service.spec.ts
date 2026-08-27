import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { AuthService } from './auth.service';

function signSep53(kp: Keypair, challenge: string): string {
  const payload = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf8'),
    Buffer.from(challenge, 'utf8'),
  ]);
  const hash = createHash('sha256').update(payload).digest();
  return Buffer.from(kp.sign(hash)).toString('base64');
}

const KEY_A = 'a'.repeat(32);
const KEY_SHARED = 'z'.repeat(40);

function makeService(cfgOverrides: Record<string, any> = {}) {
  const jwt = { signAsync: jest.fn().mockResolvedValue('jwt-token') } as any;
  const cfg = {
    challengeTtl: 300,
    jwtTtl: 900,
    jwtSecret: KEY_A,
    jwtIssuer: 'https://lolipay.app',
    jwtAudience: 'lolipay-app',
    adminAddresses: [] as string[],
    ...cfgOverrides,
  } as any;
  const prisma = {
    walletLink: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    lp: { findUnique: jest.fn().mockResolvedValue(null) },
  } as any;
  const consumed = { consume: jest.fn().mockResolvedValue(true) } as any;
  return {
    svc: new AuthService(
      jwt,
      cfg,
      prisma,
      { proveWallet: jest.fn().mockResolvedValue({ id: 'person-test' }) } as any,
      consumed,
    ),
    jwt,
    cfg,
    prisma,
    consumed,
  };
}

describe('a signature that has already bought a session cannot buy another', () => {
  it('refuses the second use of one challenge', async () => {
    const { svc, consumed } = makeService();
    const kp = Keypair.random();
    const challenge = svc.issueChallenge(kp.publicKey());
    const signature = signSep53(kp, challenge);

    await expect(svc.verify(kp.publicKey(), challenge, signature)).resolves.toBe('jwt-token');

    consumed.consume.mockResolvedValueOnce(false);
    await expect(svc.verify(kp.publicKey(), challenge, signature)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('consumes the nonce, not the whole challenge, and bounds it by the challenge expiry', async () => {
    const { svc, consumed } = makeService();
    const kp = Keypair.random();
    const challenge = svc.issueChallenge(kp.publicKey());

    await svc.verify(kp.publicKey(), challenge, signSep53(kp, challenge));

    const [nonce, expiresAt] = consumed.consume.mock.calls[0];
    expect(nonce).toBe(challenge.split(':')[2]);
    expect(expiresAt).toEqual(new Date(Number(challenge.split(':')[3])));
  });

  it('does not spend the nonce when the signature is wrong, so a wrong guess cannot lock the real holder out', async () => {
    const { svc, consumed } = makeService();
    const kp = Keypair.random();
    const challenge = svc.issueChallenge(kp.publicKey());

    await expect(
      svc.verify(kp.publicKey(), challenge, signSep53(Keypair.random(), challenge)),
    ).rejects.toThrow(UnauthorizedException);

    expect(consumed.consume).not.toHaveBeenCalled();
  });
});

describe('AuthService (stateless HMAC challenge)', () => {
  it('round-trips: issue → sign → verify returns a JWT', async () => {
    const kp = Keypair.random();
    const { svc, jwt } = makeService();
    const challenge = svc.issueChallenge(kp.publicKey());
    const sig = signSep53(kp, challenge);
    const token = await svc.verify(kp.publicKey(), challenge, sig);
    expect(token).toBe('jwt-token');
    expect(jwt.signAsync).toHaveBeenCalledWith(
      { sub: kp.publicKey(), role: 'user', cls: 'session' },
      { expiresIn: 900, issuer: 'https://lolipay.app/', audience: 'lolipay-app' },
    );
  });

  it('challenge from one instance verifies on a FRESH instance (survives restart / scales)', async () => {
    const kp = Keypair.random();
    const a = makeService({ jwtSecret: KEY_SHARED });
    const b = makeService({ jwtSecret: KEY_SHARED });
    const challenge = a.svc.issueChallenge(kp.publicKey());
    const sig = signSep53(kp, challenge);
    await expect(b.svc.verify(kp.publicKey(), challenge, sig)).resolves.toBe('jwt-token');
  });

  it('rejects a tampered HMAC', async () => {
    const kp = Keypair.random();
    const { svc } = makeService();
    const challenge = svc.issueChallenge(kp.publicKey());
    const last = challenge.slice(-1) === '0' ? '1' : '0';
    const tampered = challenge.slice(0, -1) + last;
    const sig = signSep53(kp, tampered);
    await expect(svc.verify(kp.publicKey(), tampered, sig)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an expired challenge', async () => {
    const kp = Keypair.random();
    const { svc } = makeService({ challengeTtl: -10 });
    const challenge = svc.issueChallenge(kp.publicKey());
    const sig = signSep53(kp, challenge);
    await expect(svc.verify(kp.publicKey(), challenge, sig)).rejects.toThrow(
      /expired or unknown/,
    );
  });

  it('rejects an address that does not match the challenge', async () => {
    const kp = Keypair.random();
    const other = Keypair.random();
    const { svc } = makeService();
    const challenge = svc.issueChallenge(kp.publicKey());
    const sig = signSep53(kp, challenge);
    await expect(svc.verify(other.publicKey(), challenge, sig)).rejects.toThrow(
      /address mismatch/,
    );
  });

  it('rejects a bad signature', async () => {
    const kp = Keypair.random();
    const impostor = Keypair.random();
    const { svc } = makeService();
    const challenge = svc.issueChallenge(kp.publicKey());
    const sig = signSep53(impostor, challenge);
    await expect(svc.verify(kp.publicKey(), challenge, sig)).rejects.toThrow(
      /bad signature/,
    );
  });

  it('rejects a malformed challenge', async () => {
    const kp = Keypair.random();
    const { svc } = makeService();
    await expect(svc.verify(kp.publicKey(), 'not-a-real-challenge', 'AAAA')).rejects.toThrow(
      /malformed challenge/,
    );
  });

  it('resolves admin role for an allowlisted address', async () => {
    const kp = Keypair.random();
    const { svc, jwt } = makeService({ adminAddresses: [kp.publicKey()] });
    const challenge = svc.issueChallenge(kp.publicKey());
    const sig = signSep53(kp, challenge);
    await svc.verify(kp.publicKey(), challenge, sig);
    expect(jwt.signAsync).toHaveBeenCalledWith(
      { sub: kp.publicKey(), role: 'admin', cls: 'session' },
      { expiresIn: 900, issuer: 'https://lolipay.app/', audience: 'lolipay-app' },
    );
  });
});
