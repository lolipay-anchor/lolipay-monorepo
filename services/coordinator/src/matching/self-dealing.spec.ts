import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { PersonId, PersonService } from '../person/person.service';

const PM = { id: 'pm1', rail: 'BANK', active: true, currency: 'IDR', details: 'BCA 123' };
const PM2 = { id: 'pm2', rail: 'BANK', active: true, currency: 'IDR', details: 'BNI 456' };

const PERSON = 'person-1' as PersonId;
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
    $queryRaw: jest.fn().mockResolvedValue([{ total: '0' }]),
  } as any;
}

function makeStellar(eligibility: Record<string, boolean>) {
  return {
    getStakeInfo: jest.fn().mockImplementation((addr: string) =>
      Promise.resolve({
        staked: '1000000000000',
        unbonding: '0',
        unbond_available_at: 0,
        min_stake: '1',
        eligible: eligibility[addr] ?? false,
      }),
    ),
  } as any;
}

function makePeople(wallets: Record<string, string[]>, owners: Record<string, string> = {}) {
  return {
    walletsOf: jest.fn(async (personId: string) => wallets[personId] ?? []),
    lookupPerson: jest.fn(async (address: string) =>
      owners[address] ? { id: owners[address] } : null,
    ),
  } as any;
}

describe('MatchingService refuses to pair a person with their own provider', () => {
  it('refuses when the only eligible provider is a wallet of the same person', async () => {
    const prisma = makePrisma([makeCandidate('lp-mine', MINE, 0)]);
    const stellar = makeStellar({ [MINE]: true });
    const svc = new MatchingService(prisma, stellar, makePeople({ [PERSON]: [MINE] }));

    await expect(svc.pickLp('BANK', 'IDR', 1n, PERSON)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.pickLp('BANK', 'IDR', 1n, PERSON)).rejects.toThrow(/your own order/i);
  });

  it('never asks the chain about a provider it has already refused as the caller themselves', async () => {
    const prisma = makePrisma([makeCandidate('lp-mine', MINE, 0)]);
    const stellar = makeStellar({ [MINE]: true });
    const svc = new MatchingService(prisma, stellar, makePeople({ [PERSON]: [MINE] }));

    await expect(svc.pickLp('BANK', 'IDR', 1n, PERSON)).rejects.toBeInstanceOf(ForbiddenException);
    expect(stellar.getStakeInfo).not.toHaveBeenCalled();
  });

  it('picks another eligible provider rather than refusing, when one exists', async () => {
    const prisma = makePrisma([
      makeCandidate('lp-mine', MINE, 0),
      makeCandidate('lp-theirs', THEIRS, 1, PM2),
    ]);
    const stellar = makeStellar({ [MINE]: true, [THEIRS]: true });
    const svc = new MatchingService(prisma, stellar, makePeople({ [PERSON]: [MINE] }));

    const match = await svc.pickLp('BANK', 'IDR', 1n, PERSON);

    expect(match.stellarAddress).toBe(THEIRS);
  });

  it('still offers that provider to a different person', async () => {
    const prisma = makePrisma([makeCandidate('lp-mine', MINE, 0)]);
    const stellar = makeStellar({ [MINE]: true });
    const svc = new MatchingService(prisma, stellar, makePeople({ [PERSON]: [MINE] }));

    const match = await svc.pickLp('BANK', 'IDR', 1n, 'person-2' as PersonId);

    expect(match.stellarAddress).toBe(MINE);
  });

  it('reports "no eligible provider" — not "that provider is you" — when others existed but none qualified', async () => {
    const prisma = makePrisma([
      makeCandidate('lp-mine', MINE, 0),
      makeCandidate('lp-theirs', THEIRS, 1, PM2),
    ]);
    const stellar = makeStellar({ [MINE]: true, [THEIRS]: false });
    const svc = new MatchingService(prisma, stellar, makePeople({ [PERSON]: [MINE] }));

    await expect(svc.pickLp('BANK', 'IDR', 1n, PERSON)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('excludes a wallet the person revoked, read through the real person service', async () => {
    const prisma = makePrisma([makeCandidate('lp-mine', MINE, 0)]);
    const rows = [{ stellarAddress: MINE, personId: PERSON, status: 'REVOKED' }];
    prisma.walletLink = {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter(
          (r) =>
            r.personId === where.personId &&
            (where.status === undefined || r.status === where.status),
        ),
      ),
    };
    const stellar = makeStellar({ [MINE]: true });
    const svc = new MatchingService(prisma, stellar, new PersonService(prisma));

    await expect(svc.pickLp('BANK', 'IDR', 1n, PERSON)).rejects.toBeInstanceOf(ForbiddenException);
    expect(stellar.getStakeInfo).not.toHaveBeenCalled();
  });

  it('matches as before when the caller has no person to exclude', async () => {
    const prisma = makePrisma([makeCandidate('lp-mine', MINE, 0)]);
    const stellar = makeStellar({ [MINE]: true });
    const people = makePeople({});
    const svc = new MatchingService(prisma, stellar, people);

    const match = await svc.pickLp('BANK', 'IDR', 1n);

    expect(match.stellarAddress).toBe(MINE);
    expect(people.walletsOf).not.toHaveBeenCalled();
  });

  it('refuses the chosen provider on a second, independent reading of who owns it', async () => {
    const prisma = makePrisma([makeCandidate('lp-mine', MINE, 0)]);
    const stellar = makeStellar({ [MINE]: true });
    const blindToTheLink = makePeople({}, { [MINE]: PERSON });
    const svc = new MatchingService(prisma, stellar, blindToTheLink);

    await expect(svc.pickLp('BANK', 'IDR', 1n, PERSON)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(blindToTheLink.walletsOf).toHaveBeenCalled();
  });

  it('lets the second reading through when the provider belongs to somebody else', async () => {
    const prisma = makePrisma([makeCandidate('lp-theirs', THEIRS, 0)]);
    const stellar = makeStellar({ [THEIRS]: true });
    const people = makePeople({}, { [THEIRS]: 'person-9' });
    const svc = new MatchingService(prisma, stellar, people);

    const match = await svc.pickLp('BANK', 'IDR', 1n, PERSON);

    expect(match.stellarAddress).toBe(THEIRS);
  });
});
