import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { MatchingService, matchableLpWhere } from './matching.service';
import type { PersonId } from '../person/person.service';

const PM = { id: 'pm1', rail: 'BANK', active: true, currency: 'IDR', details: 'BCA 123' };
const PM2 = { id: 'pm2', rail: 'BANK', active: true, currency: 'IDR', details: 'BNI 456' };
const PM_PHP = { id: 'pm3', rail: 'BANK', active: true, currency: 'PHP', details: 'BDO 789' };
const PM_MULTI_IDR = {
  id: 'pm-multi-idr',
  rail: 'BANK',
  active: true,
  currency: 'IDR',
  details: 'Multi IDR',
};
const PM_MULTI_PHP = {
  id: 'pm-multi-php',
  rail: 'BANK',
  active: true,
  currency: 'PHP',
  details: 'Multi PHP',
};

function makeCandidate(
  id: string,
  address: string,
  orderCount: number,
  pm = PM,
) {
  return {
    id,
    stellarAddress: address,
    paymentMethods: [pm],
    _count: { orders: orderCount },
  };
}

function makeCandidateMulti(id: string, address: string, orderCount: number, pms: any[]) {
  return {
    id,
    stellarAddress: address,
    paymentMethods: pms,
    _count: { orders: orderCount },
  };
}

function makePrisma(candidates: any[]) {
  return {
    lp: {
      findMany: jest.fn().mockImplementation(async ({ where, include }: any) => {
        const { rail, currency } = where.paymentMethods.some;
        const hasEligiblePm = (pm: any) => pm.rail === rail && pm.active && pm.currency === currency;

        const includeWhere = include.paymentMethods.where;
        const matchesField = (pm: any, key: string) =>
          !(key in includeWhere) || pm[key] === includeWhere[key];
        const includeFilter = (pm: any) =>
          matchesField(pm, 'rail') && matchesField(pm, 'active') && matchesField(pm, 'currency');

        return candidates
          .filter((c) => c.paymentMethods.some(hasEligiblePm))
          .map((c) => ({ ...c, paymentMethods: c.paymentMethods.filter(includeFilter) }));
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ total: '0' }]),
  } as any;
}

function makeStellar(eligibilityMap: Record<string, boolean>) {
  return {
    getStakeInfo: jest.fn().mockImplementation((addr: string) =>
      Promise.resolve({
        staked: '1000000000000',
        unbonding: '0',
        unbond_available_at: 0,
        min_stake: '1',
        eligible: eligibilityMap[addr] ?? false,
      }),
    ),
  } as any;
}

describe('MatchingService.pickLp', () => {
  it('picks the least-active eligible LP', async () => {
    const busyLp = makeCandidate('lp-busy', 'GBUSY', 5);
    const idleLp = makeCandidate('lp-idle', 'GIDLE', 1, PM2);
    const prisma = makePrisma([busyLp, idleLp]);
    const stellar = makeStellar({ GBUSY: true, GIDLE: true });

    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);
    const result = await svc.pickLp('BANK', 'IDR', 1n);

    expect(result.id).toBe('lp-idle');
    expect(result.stellarAddress).toBe('GIDLE');
    expect(result.details).toBe('BNI 456');
  });

  it('skips ineligible LPs and picks the next eligible one', async () => {
    const ineligible = makeCandidate('lp-bad', 'GBAD', 0);
    const eligible = makeCandidate('lp-good', 'GGOOD', 2, PM2);

    const prisma = makePrisma([ineligible, eligible]);
    const stellar = makeStellar({ GBAD: false, GGOOD: true });

    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);
    const result = await svc.pickLp('BANK', 'IDR', 1n);

    expect(result.id).toBe('lp-good');
    expect(result.stellarAddress).toBe('GGOOD');
  });

  it('throws 503 when all candidates are ineligible', async () => {
    const lp1 = makeCandidate('lp-a', 'GAAAA', 0);
    const lp2 = makeCandidate('lp-b', 'GBBBB', 1);
    const prisma = makePrisma([lp1, lp2]);
    const stellar = makeStellar({ GAAAA: false, GBBBB: false });

    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);
    await expect(svc.pickLp('BANK', 'IDR', 1n)).rejects.toThrow(ServiceUnavailableException);
    await expect(svc.pickLp('BANK', 'IDR', 1n)).rejects.toThrow('no eligible LP available');
  });

  it('throws 503 when no candidates at all', async () => {
    const prisma = makePrisma([]);
    const stellar = makeStellar({});

    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);
    await expect(svc.pickLp('QRIS', 'IDR', 1n)).rejects.toThrow(ServiceUnavailableException);
  });

  it('excludes an LP whose only payment method is for a different fiat currency', async () => {
    const phpOnlyLp = makeCandidate('lp-php', 'GPHP', 0, PM_PHP);
    const idrLp = makeCandidate('lp-idr', 'GIDR', 2, PM);
    const prisma = makePrisma([phpOnlyLp, idrLp]);
    const stellar = makeStellar({ GPHP: true, GIDR: true });

    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);
    const result = await svc.pickLp('BANK', 'IDR', 1n);

    expect(result.id).toBe('lp-idr');
    expect(result.stellarAddress).toBe('GIDR');
  });

  it('throws 503 when no candidate has a payment method in the requested currency', async () => {
    const phpOnlyLp = makeCandidate('lp-php', 'GPHP', 0, PM_PHP);
    const prisma = makePrisma([phpOnlyLp]);
    const stellar = makeStellar({ GPHP: true });

    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);
    await expect(svc.pickLp('BANK', 'IDR', 1n)).rejects.toThrow(ServiceUnavailableException);
  });

  it('queries only LPs with online:true (persistent intent) AND a fresh lastHeartbeatAt (liveness) — never one alone', async () => {
    const idrLp = makeCandidate('lp-idr', 'GIDR', 0, PM);
    const prisma = makePrisma([idrLp]);
    const stellar = makeStellar({ GIDR: true });

    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);
    await svc.pickLp('BANK', 'IDR', 1n);

    expect(prisma.lp.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          online: true,
          lastHeartbeatAt: { gt: expect.any(Date) },
        }),
      }),
    );
  });

  it('asks for every provider the shared matchability rule names, so the monitor that counts them cannot drift from the matcher that picks them', async () => {
    const prisma = makePrisma([makeCandidate('lp-a', 'GA', 0, PM)]);
    const stellar = makeStellar({ GA: true });
    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);

    await svc.pickLp('BANK', 'IDR', 1n);

    const where = prisma.lp.findMany.mock.calls[0][0].where;
    const shared = matchableLpWhere();
    for (const key of Object.keys(shared)) {
      expect(Object.keys(where)).toContain(key);
    }
    expect(where.status).toBe(shared.status);
    expect(where.online).toBe(shared.online);
    expect(where.lastHeartbeatAt.gt).toBeInstanceOf(Date);
  });

  it('queries LPs filtered by rail, active, AND fiat currency', async () => {
    const idrLp = makeCandidate('lp-idr', 'GIDR', 0, PM);
    const prisma = makePrisma([idrLp]);
    const stellar = makeStellar({ GIDR: true });

    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);

    await svc.pickLp('BANK', 'PHP', 1n).catch(() => {});

    expect(prisma.lp.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paymentMethods: { some: { rail: 'BANK', active: true, currency: 'PHP' } },
        }),
      }),
    );
  });

  it('returns the IDR-specific payment method for an LP serving both IDR and PHP on the same rail', async () => {
    const multiLp = makeCandidateMulti('lp-multi', 'GMULTI', 0, [PM_MULTI_PHP, PM_MULTI_IDR]);
    const prisma = makePrisma([multiLp]);
    const stellar = makeStellar({ GMULTI: true });

    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);
    const result = await svc.pickLp('BANK', 'IDR', 1n);

    expect(result.paymentMethodId).toBe(PM_MULTI_IDR.id);
    expect(result.details).toBe(PM_MULTI_IDR.details);
  });

  it('returns the PHP-specific payment method for the same multi-currency LP when queried by PHP', async () => {
    const multiLp = makeCandidateMulti('lp-multi', 'GMULTI', 0, [PM_MULTI_IDR, PM_MULTI_PHP]);
    const prisma = makePrisma([multiLp]);
    const stellar = makeStellar({ GMULTI: true });

    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);
    const result = await svc.pickLp('BANK', 'PHP', 1n);

    expect(result.paymentMethodId).toBe(PM_MULTI_PHP.id);
    expect(result.details).toBe(PM_MULTI_PHP.details);
  });

  it('logs a per-reason breakdown when no provider matches, so an operator can tell a full book from an outage without reading the sentence a depositor sees', async () => {
    const own = makeCandidate('lp-own', 'GOWN', 0, PM);
    const rpcDown = makeCandidate('lp-rpc', 'GRPC', 0, PM);
    const ineligible = makeCandidate('lp-inel', 'GINEL', 0, PM);
    const overCap = makeCandidate('lp-cap', 'GCAP', 0, PM);
    const prisma = makePrisma([own, rpcDown, ineligible, overCap]);
    const stellar = {
      getStakeInfo: jest.fn((addr: string) => {
        if (addr === 'GRPC') return Promise.reject(new Error('rpc unreachable'));
        if (addr === 'GINEL') {
          return Promise.resolve({ staked: '1000000000000', unbonding: '0', eligible: false });
        }
        if (addr === 'GCAP') {
          return Promise.resolve({ staked: '0', unbonding: '0', eligible: true });
        }
        return Promise.resolve({ staked: '1000000000000', unbonding: '0', eligible: true });
      }),
    } as any;
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const svc = new MatchingService(prisma, stellar, {
      walletsOf: jest.fn(async () => ['GOWN']),
      lookupPerson: jest.fn(async () => null),
    } as any);

    await expect(svc.pickLp('BANK', 'IDR', 100n, 'person-1' as PersonId)).rejects.toThrow(
      ServiceUnavailableException,
    );

    expect(warnSpy).toHaveBeenCalledWith(
      "no provider took BANK/IDR for 100 base units — 4 matchable, 1 excluded as the requester's own, " +
        '1 stake unreadable, 1 ineligible or unbonding, 1 over capacity',
    );

    warnSpy.mockRestore();
  });

  it('counts an eligible-but-unbonding LP under "ineligible or unbonding" too, so the disjunction is not proven by only one of its halves', async () => {
    const unbonding = makeCandidate('lp-unbonding', 'GUNBOND', 0, PM);
    const prisma = makePrisma([unbonding]);
    const stellar = {
      getStakeInfo: jest.fn(() =>
        Promise.resolve({ staked: '1000000000000', unbonding: '1', eligible: true }),
      ),
    } as any;
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);

    await expect(svc.pickLp('BANK', 'IDR', 1n)).rejects.toThrow(ServiceUnavailableException);

    expect(warnSpy).toHaveBeenCalledWith(
      "no provider took BANK/IDR for 1 base units — 1 matchable, 0 excluded as the requester's own, " +
        '0 stake unreadable, 1 ineligible or unbonding, 0 over capacity',
    );

    warnSpy.mockRestore();
  });

  it('does not change the exception the depositor sees when logging the per-reason breakdown', async () => {
    const rpcDown = makeCandidate('lp-rpc', 'GRPC', 0, PM);
    const prisma = makePrisma([rpcDown]);
    const stellar = { getStakeInfo: jest.fn(() => Promise.reject(new Error('rpc unreachable'))) } as any;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const svc = new MatchingService(prisma, stellar, { walletsOf: jest.fn(), lookupPerson: jest.fn(async () => null) } as any);

    await expect(svc.pickLp('BANK', 'IDR', 1n)).rejects.toThrow(ServiceUnavailableException);
    await expect(svc.pickLp('BANK', 'IDR', 1n)).rejects.toThrow('no eligible LP available');

    (Logger.prototype.warn as jest.Mock).mockRestore();
  });
});
