import { ServiceUnavailableException } from '@nestjs/common';
import { OrderService } from '../order/order.service';
import { PersonId, PersonService } from '../person/person.service';
import { UserReputationService } from './user-reputation.service';
import { orderStatusFor, orderTxFor } from '../order/test-helpers';

const ADDR_1 = 'GWALLETONE';
const ADDR_2 = 'GWALLETTWO';
const LP = 'GLP';
const PLATFORM = 'GPLATFORM';

const HALF_LIMIT = 50_000_000n;
const LIMIT_BASE = 90_000_000n;

function makeWorld(opts: { personCreateThrows?: boolean } = {}) {
  const people = new Map<string, any>();
  const links = new Map<string, any>();
  const orders: any[] = [];
  const profiles = new Map<string, any>();
  let seq = 0;

  const quote = (id: string, userAddress: string) => ({
    id,
    userAddress,
    flow: 'TOP_UP',
    rail: 'BANK',
    usdcAmount: HALF_LIMIT,
    fiatAmount: 800_000n,
    fiatCurrency: 'IDR',
    rateSnapshot: '16000',
    platformFeeBps: 30,
    lpFeeBps: 120,
    usedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const quotes = new Map<string, any>([
    ['q1', quote('q1', ADDR_1)],
    ['q2', quote('q2', ADDR_2)],
  ]);

  const client: any = {
    person: {
      create: jest.fn(async () => {
        if (opts.personCreateThrows) throw new Error('database is down');
        const p = { id: `person-${++seq}` };
        people.set(p.id, p);
        return p;
      }),
    },
    walletLink: {
      findUnique: jest.fn(async ({ where, include }: any) => {
        const l = links.get(where.stellarAddress);
        if (!l) return null;
        return include?.person ? { ...l, person: people.get(l.personId) } : l;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        [...links.values()].filter((l) => l.personId === where.personId),
      ),
      create: jest.fn(async ({ data }: any) => {
        links.set(data.stellarAddress, { status: 'ACTIVE', ...data });
        return data;
      }),
    },
    userProfile: {
      findUnique: jest.fn(async ({ where }: any) => profiles.get(where.address) ?? null),
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: {
          disputesLost: [...profiles.values()]
            .filter((p) => where.address.in.includes(p.address))
            .reduce((a, p) => a + p.disputesLost, 0),
        },
      })),
    },
    order: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `ord-${orders.length + 1}`,
          createdAt: new Date(),
          payDeadline: 0n,
          confirmDeadline: 0n,
          disputeDeadline: 0n,
          expiresAt: new Date(),
          ...data,
        };
        orders.push(row);
        return row;
      }),
      count: jest.fn(async ({ where }: any) =>
        orders.filter((o) => o.personId === where.personId && o.status === where.status).length,
      ),
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: {
          usdcAmount: orders
            .filter((o) => o.personId === where.personId)
            .reduce((a, o) => a + o.usdcAmount, 0n),
        },
      })),
    },
    quote: {
      findUnique: jest.fn(async ({ where }: any) => quotes.get(where.id) ?? null),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    config: {
      upsert: jest.fn(async () => ({
        id: 1,
        paused: false,
        minOrder: 1n,
        maxOrder: 10_000_000_000n,
        platformWallet: PLATFORM,
        payWindowSecs: 1800,
        confirmWindowSecs: 1800,
        disputeWindowSecs: 1800,
        dailyLimitByTier: { BRONZE: 10 },
      })),
    },
    $executeRaw: jest.fn(async () => 0),
    $queryRaw: jest.fn(async () => [{ total: '0' }]),
  };
  client.$transaction = jest.fn(async (cb: any) => cb(client));

  const personSvc = new PersonService(client);
  const reputation = new UserReputationService(client, personSvc);
  jest.spyOn(reputation, 'dailyLimitBaseUnits').mockReturnValue(LIMIT_BASE);

  const stellar = { getStakeInfo: jest.fn().mockResolvedValue({ staked: '1000000000000', unbonding: '0', unbond_available_at: 0, min_stake: '1', eligible: true }),  hasUsdcTrustline: jest.fn().mockResolvedValue(true) } as any;
  const matching = {
    pickLp: jest.fn().mockResolvedValue({
      id: 'lp1',
      stellarAddress: LP,
      paymentMethodId: 'pm1',
      details: 'BCA 123',
    }),
  } as any;
  const cfg = { platformWallet: PLATFORM } as any;
  const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
  const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;

  const svc = new OrderService(
    client,
    stellar,
    matching,
    cfg,
    markets,
    notifications,
    {} as any,
    reputation,
    orderStatusFor(client, stellar, cfg),
    orderTxFor(client, stellar, cfg),
  );

  return { svc, client, personSvc, reputation, orders, profiles, links };
}

describe('one person gets one limit, one lock and one history', () => {
  it('gives one person one daily limit, however many wallets they link', async () => {
    const { svc, personSvc, client } = makeWorld();
    const person = await personSvc.proveWallet(ADDR_1, 'SEP53');
    await client.walletLink.create({
      data: { stellarAddress: ADDR_2, personId: person.id, authMethod: 'SEP53' },
    });
    expect(await personSvc.walletsOf(person.id as PersonId)).toHaveLength(2);

    await svc.createFromQuote(ADDR_1, 'q1');

    await expect(svc.createFromQuote(ADDR_2, 'q2')).rejects.toThrow(/daily limit/i);
  });

  it('still lets an unrelated person spend their own limit', async () => {
    const { svc, personSvc } = makeWorld();
    await personSvc.proveWallet(ADDR_1, 'SEP53');
    await personSvc.proveWallet(ADDR_2, 'SEP53');

    await svc.createFromQuote(ADDR_1, 'q1');

    await expect(svc.createFromQuote(ADDR_2, 'q2')).resolves.toBeDefined();
  });

  it('takes the advisory lock on the person, not the wallet', async () => {
    const { svc, client, personSvc } = makeWorld();
    const person = await personSvc.proveWallet(ADDR_1, 'SEP53');
    await svc.createFromQuote(ADDR_1, 'q1');

    const [strings, ...values] = client.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain('pg_advisory_xact_lock');
    expect(values).toContain(person.id);
    expect(values).not.toContain(ADDR_1);
  });

  it('stamps the order with the person it was priced against', async () => {
    const { svc, orders, personSvc } = makeWorld();
    const person = await personSvc.proveWallet(ADDR_1, 'SEP53');
    await svc.createFromQuote(ADDR_1, 'q1');

    expect(orders[0].personId).toBe(person.id);
  });

  it('counts settled trades across every wallet the person has linked', async () => {
    const { reputation, personSvc, orders, client } = makeWorld();
    const person = await personSvc.proveWallet(ADDR_1, 'SEP53');
    await client.walletLink.create({
      data: { stellarAddress: ADDR_2, personId: person.id, authMethod: 'SEP53' },
    });
    orders.push({ personId: person.id, userAddress: ADDR_1, status: 'RELEASED', usdcAmount: 1n });
    orders.push({ personId: person.id, userAddress: ADDR_2, status: 'RELEASED', usdcAmount: 1n });

    const rep = await reputation.getReputation(await reputation.personIdFor(ADDR_1));

    expect(rep.completedTrades).toBe(2);
  });

  it('carries a dispute loss from one wallet onto the whole person', async () => {
    const { reputation, personSvc, profiles, client } = makeWorld();
    const person = await personSvc.proveWallet(ADDR_1, 'SEP53');
    await client.walletLink.create({
      data: { stellarAddress: ADDR_2, personId: person.id, authMethod: 'SEP53' },
    });
    profiles.set(ADDR_2, { address: ADDR_2, disputesLost: 1 });

    const rep = await reputation.getReputation(await reputation.personIdFor(ADDR_1));

    expect(rep.disputesLost).toBe(1);
  });

  it('refuses to price an order when no person can be established, rather than skipping the limit', async () => {
    const { svc, reputation } = makeWorld({ personCreateThrows: true });
    const used = jest.spyOn(reputation, 'used24hBaseUnits');

    await expect(svc.createFromQuote(ADDR_1, 'q1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(used).not.toHaveBeenCalled();
  });
});
