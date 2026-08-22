import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { AuthService } from '../auth/auth.service';
import { PersonService, WALLET_CAP } from './person.service';

function signSep53(kp: Keypair, challenge: string): string {
  const payload = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf8'),
    Buffer.from(challenge, 'utf8'),
  ]);
  const hash = createHash('sha256').update(payload).digest();
  return Buffer.from(kp.sign(hash)).toString('base64');
}

function makePrisma() {
  const links = new Map<string, any>();
  const challenges = new Map<string, any>();

  const client: any = {
    person: {
      create: jest.fn(async () => ({ id: 'person-new' })),
    },
    walletLink: {
      findUnique: jest.fn(async ({ where }: any) => links.get(where.stellarAddress) ?? null),
      count: jest.fn(async ({ where }: any) =>
        [...links.values()].filter(
          (l) => l.personId === where.personId && l.status === where.status,
        ).length,
      ),
      create: jest.fn(async ({ data }: any) => {
        if (links.has(data.stellarAddress)) {
          const e: any = new Error('Unique constraint failed');
          e.code = 'P2002';
          throw e;
        }
        const row = { status: 'ACTIVE', ...data };
        links.set(row.stellarAddress, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = { ...links.get(where.stellarAddress), ...data };
        links.set(where.stellarAddress, row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = [...links.values()].filter(
          (l) =>
            l.stellarAddress === where.stellarAddress &&
            l.personId === where.personId &&
            (where.status ? l.status === where.status : true),
        );
        hit.forEach((l) => links.set(l.stellarAddress, { ...l, ...data }));
        return { count: hit.length };
      }),
    },
    walletLinkChallenge: {
      create: jest.fn(async ({ data }: any) => {
        challenges.set(data.nonce, { ...data });
        return data;
      }),
      findUnique: jest.fn(async ({ where }: any) => challenges.get(where.nonce) ?? null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = challenges.get(where.nonce);
        if (!row || row.consumedAt !== null) return { count: 0 };
        challenges.set(where.nonce, { ...row, ...data });
        return { count: 1 };
      }),
    },
  };
  client.$transaction = jest.fn(async (cb: any) => cb(client));
  return { client, links, challenges };
}

function seedLink(links: Map<string, any>, address: string, personId: string, status = 'ACTIVE') {
  links.set(address, { stellarAddress: address, personId, authMethod: 'SEP53', status });
}

const PERSON_A = 'person-a';
const PERSON_B = 'person-b';

describe('PersonService wallet linking demands a fresh, single-use proof', () => {
  let prisma: any;
  let links: Map<string, any>;
  let svc: PersonService;
  let kp: Keypair;

  beforeEach(() => {
    const made = makePrisma();
    prisma = made.client;
    links = made.links;
    svc = new PersonService(prisma);
    kp = Keypair.random();
  });

  it('refuses a link with no valid signature from the address', async () => {
    const challenge = await svc.issueLinkChallenge(PERSON_A, kp.publicKey());

    await expect(
      svc.linkWallet(PERSON_A, kp.publicKey(), { challenge, signature: 'not-a-signature' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.walletLink.create).not.toHaveBeenCalled();
  });

  it('refuses a login challenge presented as a link proof', async () => {
    const auth = new AuthService(
      { signAsync: jest.fn() } as any,
      { challengeTtl: 300, jwtTtl: 900, jwtSecret: 'a'.repeat(32), adminAddresses: [] } as any,
      { lp: { findUnique: jest.fn() } } as any,
    );
    const login = auth.issueChallenge(kp.publicKey());

    await expect(
      svc.linkWallet(PERSON_A, kp.publicKey(), {
        challenge: login,
        signature: signSep53(kp, login),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.walletLink.create).not.toHaveBeenCalled();
  });

  it('links when the signature comes from the address and the challenge is ours', async () => {
    const challenge = await svc.issueLinkChallenge(PERSON_A, kp.publicKey());

    const link = await svc.linkWallet(PERSON_A, kp.publicKey(), {
      challenge,
      signature: signSep53(kp, challenge),
    });

    expect(link.stellarAddress).toBe(kp.publicKey());
    expect(link.personId).toBe(PERSON_A);
    expect(link.status).toBe('ACTIVE');
  });

  it('refuses a challenge minted for a different address', async () => {
    const other = Keypair.random();
    const challenge = await svc.issueLinkChallenge(PERSON_A, other.publicKey());

    await expect(
      svc.linkWallet(PERSON_A, kp.publicKey(), {
        challenge,
        signature: signSep53(kp, challenge),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a challenge minted for a different person', async () => {
    const challenge = await svc.issueLinkChallenge(PERSON_B, kp.publicKey());

    await expect(
      svc.linkWallet(PERSON_A, kp.publicKey(), {
        challenge,
        signature: signSep53(kp, challenge),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses an expired challenge', async () => {
    const challenge = await svc.issueLinkChallenge(PERSON_A, kp.publicKey());
    const nonce = challenge.split(':')[2];
    const row = (await prisma.walletLinkChallenge.findUnique({ where: { nonce } }))!;
    row.expiresAt = new Date(Date.now() - 1000);

    await expect(
      svc.linkWallet(PERSON_A, kp.publicKey(), {
        challenge,
        signature: signSep53(kp, challenge),
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('consumes the challenge, so the same proof cannot be replayed', async () => {
    seedLink(links, 'GKEEP', PERSON_A);
    const challenge = await svc.issueLinkChallenge(PERSON_A, kp.publicKey());
    const proof = { challenge, signature: signSep53(kp, challenge) };

    await svc.linkWallet(PERSON_A, kp.publicKey(), proof);
    await svc.revokeWallet(PERSON_A, kp.publicKey());

    await expect(svc.linkWallet(PERSON_A, kp.publicKey(), proof)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('links only once when one proof is used twice at the same moment', async () => {
    const challenge = await svc.issueLinkChallenge(PERSON_A, kp.publicKey());
    const proof = { challenge, signature: signSep53(kp, challenge) };

    const results = await Promise.allSettled([
      svc.linkWallet(PERSON_A, kp.publicKey(), proof),
      svc.linkWallet(PERSON_A, kp.publicKey(), proof),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('refuses an address that already belongs to a different person', async () => {
    seedLink(links, kp.publicKey(), PERSON_A);
    const challenge = await svc.issueLinkChallenge(PERSON_B, kp.publicKey());

    await expect(
      svc.linkWallet(PERSON_B, kp.publicKey(), {
        challenge,
        signature: signSep53(kp, challenge),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not free the address when a link is revoked', async () => {
    seedLink(links, kp.publicKey(), PERSON_A);
    seedLink(links, 'GKEEP', PERSON_A);
    await svc.revokeWallet(PERSON_A, kp.publicKey());

    const challenge = await svc.issueLinkChallenge(PERSON_B, kp.publicKey());

    await expect(
      svc.linkWallet(PERSON_B, kp.publicKey(), {
        challenge,
        signature: signSep53(kp, challenge),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to revoke the only wallet a person can still sign with', async () => {
    seedLink(links, kp.publicKey(), PERSON_A);

    await expect(svc.revokeWallet(PERSON_A, kp.publicKey())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(links.get(kp.publicKey()).status).toBe('ACTIVE');
  });

  it('refuses to link beyond the cap of active wallets, naming the cap', async () => {
    for (let i = 0; i < WALLET_CAP; i++) {
      seedLink(links, `GCAP${i}`, PERSON_A);
    }
    const challenge = await svc.issueLinkChallenge(PERSON_A, kp.publicKey());

    await expect(
      svc.linkWallet(PERSON_A, kp.publicKey(), {
        challenge,
        signature: signSep53(kp, challenge),
      }),
    ).rejects.toThrow(new RegExp(String(WALLET_CAP)));
  });

  it('lets a person re-link a wallet they revoked while at the cap', async () => {
    for (let i = 0; i < WALLET_CAP - 1; i++) seedLink(links, `GCAP${i}`, PERSON_A);
    seedLink(links, kp.publicKey(), PERSON_A, 'REVOKED');
    const challenge = await svc.issueLinkChallenge(PERSON_A, kp.publicKey());

    const link = await svc.linkWallet(PERSON_A, kp.publicKey(), {
      challenge,
      signature: signSep53(kp, challenge),
    });

    expect(link.status).toBe('ACTIVE');
  });
});
