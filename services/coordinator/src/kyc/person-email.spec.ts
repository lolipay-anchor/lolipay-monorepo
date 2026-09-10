import { Sep12Service } from './sep12.service';

function make(opts: { refused?: boolean; personEmail?: string | null } = {}) {
  const personUpdates: any[] = [];
  const cleared: any[] = [];
  const prisma: any = {
    person: {
      update: jest.fn(async (a: any) => (personUpdates.push(a), {})),
      updateMany: jest.fn(async (a: any) => (cleared.push(a), { count: opts.personEmail ? 1 : 0 })),
    },
    kycVerification: {
      findFirst: jest.fn(async (a: any) => (a.where.status === 'REJECTED' && opts.refused ? { customerRef: 'GX' } : null)),
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      updateMany: jest.fn(async () => ({ count: 0 })),
      upsert: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
    },
    $executeRaw: jest.fn(async () => 0),
    $transaction: jest.fn(async (cb: any) => cb(prisma)),
  };
  const people = { lookupPerson: jest.fn(async () => ({ id: 'p1' })) } as any;
  const provider = { start: jest.fn(async () => ({ status: 'PROCESSING', providerRef: 'r', verificationUrl: 'https://v' })) } as any;
  const cfg = { kycRequireAml: false, diditEnvironment: 'sandbox' } as any;
  const refusals = { workflowPerformsAml: jest.fn(), providerFailed: jest.fn(), providerRecovered: jest.fn() } as any;
  const svc = new Sep12Service(prisma, people, provider, cfg, refusals);
  return { svc, prisma, personUpdates, cleared };
}

const FIELDS = {
  first_name: 'Budi', last_name: 'Santoso', birth_date: '1990-01-01',
  id_type: 'id_card', id_number: '123', email_address: 'budi@example.com',
};

describe('the address the anchor keeps for mail', () => {
  it('stores it on the person, where an erasure request can reach it', async () => {
    const { svc, personUpdates } = make();
    await svc.put('GABC', { ...FIELDS });
    expect(personUpdates).toHaveLength(1);
    expect(personUpdates[0]).toEqual({ where: { id: 'p1' }, data: { email: 'budi@example.com' } });
  });

  it('stores nothing when the address is not one the database would accept, so a malformed value becomes a refusal rather than a 500', async () => {
    const { svc, personUpdates } = make();
    await svc.put('GABC', { ...FIELDS, email_address: 'tezs' });
    expect(personUpdates).toHaveLength(0);
  });

  it('stores nothing for an identity that was already refused', async () => {
    const { svc, personUpdates } = make({ refused: true });
    await expect(svc.put('GABC', { ...FIELDS })).rejects.toThrow(/refused/i);
    expect(personUpdates).toHaveLength(0);
  });

  it('erasure clears it, inside the same lock the refusal redaction takes', async () => {
    const { svc, prisma, cleared } = make({ personEmail: 'budi@example.com' });
    await svc.forget('GABC');
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toEqual({ where: { id: 'p1', email: { not: null } }, data: { email: null } });
  });

  it('erasure that only cleared an address still reports having held something, so a second DELETE does not 404 while the row is already empty', async () => {
    const { svc } = make({ personEmail: 'budi@example.com' });
    await expect(svc.forget('GABC')).resolves.toBe(1);
  });
});
