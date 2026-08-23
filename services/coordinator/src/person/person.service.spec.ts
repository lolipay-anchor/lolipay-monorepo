import { PersonService } from './person.service';

const ADDR_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ADDR_B = 'GBSYTTNQVWKH2DOIWXSE6UVJXRCUIXKSC5TBPYWNLCXLS35FKH7DNOHT';

function makePrisma() {
  const people = new Map<string, any>();
  const links = new Map<string, any>();
  let seq = 0;

  const client: any = {
    person: {
      create: jest.fn(async () => {
        const p = { id: `person-${++seq}`, createdAt: new Date() };
        people.set(p.id, p);
        return p;
      }),
      findUnique: jest.fn(async ({ where }: any) => people.get(where.id) ?? null),
    },
    walletLink: {
      findUnique: jest.fn(async ({ where, include }: any) => {
        const l = links.get(where.stellarAddress);
        if (!l) return null;
        return include?.person ? { ...l, person: people.get(l.personId) } : l;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (links.has(data.stellarAddress)) {
          const e: any = new Error('Unique constraint failed');
          e.code = 'P2002';
          throw e;
        }
        links.set(data.stellarAddress, { ...data });
        return data;
      }),
    },
  };
  client.$transaction = jest.fn(async (cb: any) => {
    const wrotePeople: string[] = [];
    const wroteLinks: string[] = [];
    const scoped = {
      ...client,
      person: {
        ...client.person,
        create: jest.fn(async (args: any) => {
          const p = await client.person.create(args);
          wrotePeople.push(p.id);
          return p;
        }),
      },
      walletLink: {
        ...client.walletLink,
        create: jest.fn(async (args: any) => {
          const l = await client.walletLink.create(args);
          wroteLinks.push(args.data.stellarAddress);
          return l;
        }),
      },
    };
    try {
      return await cb(scoped);
    } catch (err) {
      wrotePeople.forEach((id) => people.delete(id));
      wroteLinks.forEach((a) => links.delete(a));
      throw err;
    }
  });
  client.people = people;
  client.links = links;
  return client;
}

describe('PersonService.proveWallet', () => {
  it('creates a person and a wallet link the first time an address is seen', async () => {
    const prisma = makePrisma();
    const svc = new PersonService(prisma);

    const person = await svc.proveWallet(ADDR_A, 'SEP10');

    expect(person.id).toBe('person-1');
    expect(prisma.walletLink.create).toHaveBeenCalledWith({
      data: { stellarAddress: ADDR_A, personId: 'person-1', authMethod: 'SEP10' },
    });
  });

  it('returns the same person the second time, and creates no second link', async () => {
    const prisma = makePrisma();
    const svc = new PersonService(prisma);

    const first = await svc.proveWallet(ADDR_A, 'SEP10');
    const second = await svc.proveWallet(ADDR_A, 'SEP10');

    expect(second.id).toBe(first.id);
    expect(prisma.walletLink.create).toHaveBeenCalledTimes(1);
    expect(prisma.person.create).toHaveBeenCalledTimes(1);
  });

  it('gives two different addresses two different people', async () => {
    const prisma = makePrisma();
    const svc = new PersonService(prisma);

    const a = await svc.proveWallet(ADDR_A, 'SEP10');
    const b = await svc.proveWallet(ADDR_B, 'SEP10');

    expect(b.id).not.toBe(a.id);
  });

  it('records how the address was proven', async () => {
    const prisma = makePrisma();
    const svc = new PersonService(prisma);

    await svc.proveWallet(ADDR_A, 'SEP53');

    expect(prisma.walletLink.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ authMethod: 'SEP53' }) }),
    );
  });

  it('yields one person when two first sightings of one address race', async () => {
    const prisma = makePrisma();
    const svc = new PersonService(prisma);

    const [a, b] = await Promise.all([
      svc.proveWallet(ADDR_A, 'SEP10'),
      svc.proveWallet(ADDR_A, 'SEP10'),
    ]);

    expect(b.id).toBe(a.id);
    expect(prisma.walletLink.create).toHaveBeenCalledTimes(2);
    expect(prisma.people.size).toBe(1);
  });
});
