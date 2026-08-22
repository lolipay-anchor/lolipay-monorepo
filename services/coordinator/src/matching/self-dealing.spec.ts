import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { MatchingService } from './matching.service';

const PM = { id: 'pm1', rail: 'BANK', active: true, currency: 'IDR', details: 'BCA 123' };
const PM2 = { id: 'pm2', rail: 'BANK', active: true, currency: 'IDR', details: 'BNI 456' };

const PERSON = 'person-1';
const MINE = 'GMYOWNLP';
const THEIRS = 'GSOMEONEELSE';

function makeCandidate(id: string, address: string, orderCount: number, pm = PM) {
  return { id, stellarAddress: address, paymentMethods: [pm], _count: { orders: orderCount } };
}

function makePrisma(candidates: any[]) {
  return {
    lp: {
      findMany: jest.fn().mockImplementation(async () =>
        candidates.map((c) => ({ ...c })),
      ),
    },
  } as any;
}

function makeStellar(eligibility: Record<string, boolean>) {
  return {
    isEligible: jest.fn().mockImplementation((addr: string) =>
      Promise.resolve(eligibility[addr] ?? false),
    ),
  } as any;
}

function makePeople(wallets: Record<string, string[]>) {
  return { walletsOf: jest.fn(async (personId: string) => wallets[personId] ?? []) } as any;
}

describe('MatchingService refuses to pair a person with their own provider', () => {
  it('refuses when the only eligible provider is a wallet of the same person', async () => {
    const prisma = makePrisma([makeCandidate('lp-mine', MINE, 0)]);
    const stellar = makeStellar({ [MINE]: true });
    const svc = new MatchingService(prisma, stellar, makePeople({ [PERSON]: [MINE] }));

    await expect(svc.pickLp('BANK', 'IDR', PERSON)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.pickLp('BANK', 'IDR', PERSON)).rejects.toThrow(/your own order/i);
  });

  it('never asks the chain about a provider it has already refused as the caller themselves', async () => {
    const prisma = makePrisma([makeCandidate('lp-mine', MINE, 0)]);
    const stellar = makeStellar({ [MINE]: true });
    const svc = new MatchingService(prisma, stellar, makePeople({ [PERSON]: [MINE] }));

    await expect(svc.pickLp('BANK', 'IDR', PERSON)).rejects.toBeInstanceOf(ForbiddenException);
    expect(stellar.isEligible).not.toHaveBeenCalled();
  });

  it('picks another eligible provider rather than refusing, when one exists', async () => {
    const prisma = makePrisma([
      makeCandidate('lp-mine', MINE, 0),
      makeCandidate('lp-theirs', THEIRS, 1, PM2),
    ]);
    const stellar = makeStellar({ [MINE]: true, [THEIRS]: true });
    const svc = new MatchingService(prisma, stellar, makePeople({ [PERSON]: [MINE] }));

    const match = await svc.pickLp('BANK', 'IDR', PERSON);

    expect(match.stellarAddress).toBe(THEIRS);
  });

  it('still offers that provider to a different person', async () => {
    const prisma = makePrisma([makeCandidate('lp-mine', MINE, 0)]);
    const stellar = makeStellar({ [MINE]: true });
    const svc = new MatchingService(prisma, stellar, makePeople({ [PERSON]: [MINE] }));

    const match = await svc.pickLp('BANK', 'IDR', 'person-2');

    expect(match.stellarAddress).toBe(MINE);
  });

  it('reports "no eligible provider" — not "that provider is you" — when others existed but none qualified', async () => {
    const prisma = makePrisma([
      makeCandidate('lp-mine', MINE, 0),
      makeCandidate('lp-theirs', THEIRS, 1, PM2),
    ]);
    const stellar = makeStellar({ [MINE]: true, [THEIRS]: false });
    const svc = new MatchingService(prisma, stellar, makePeople({ [PERSON]: [MINE] }));

    await expect(svc.pickLp('BANK', 'IDR', PERSON)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('excludes a revoked wallet of the person too', async () => {
    const prisma = makePrisma([makeCandidate('lp-mine', MINE, 0)]);
    const stellar = makeStellar({ [MINE]: true });
    const svc = new MatchingService(prisma, stellar, makePeople({ [PERSON]: [MINE] }));

    await expect(svc.pickLp('BANK', 'IDR', PERSON)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('matches as before when the caller has no person to exclude', async () => {
    const prisma = makePrisma([makeCandidate('lp-mine', MINE, 0)]);
    const stellar = makeStellar({ [MINE]: true });
    const people = makePeople({});
    const svc = new MatchingService(prisma, stellar, people);

    const match = await svc.pickLp('BANK', 'IDR');

    expect(match.stellarAddress).toBe(MINE);
    expect(people.walletsOf).not.toHaveBeenCalled();
  });
});
