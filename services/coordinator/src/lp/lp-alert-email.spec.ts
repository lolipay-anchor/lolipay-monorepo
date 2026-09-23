import { LpService } from './lp.service';

const LP_ADDR = 'GLPWALLET';

function makePrisma(alertEmail: string | null, personEmail: string | null = null) {
  const personRow = { email: personEmail };
  return {
    lp: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'lp1',
        stellarAddress: LP_ADDR,
        status: 'APPROVED',
        contact: 'provider@example.test',
        liquidityProof: 'proof',
        online: true,
        lastHeartbeatAt: null,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        approvedAt: new Date('2026-09-01T00:00:00.000Z'),
        paymentMethods: [],
        alertEmail,
        person: personRow,
      }),
      count: jest.fn().mockResolvedValue(0),
    },
    person: {
      findUnique: jest.fn().mockResolvedValue(personRow),
    },
  } as any;
}

describe('LpService.me — ADR 0054: the wire field is reachable, and it means the same disjunction as conjunct B and the enqueue gate', () => {
  it('11a — reports reachable: true for a provider with alertEmail on file and no linked Person.email, and never the address itself', async () => {
    const prisma = makePrisma('ops@example.com');

    const me = await new LpService(prisma, {} as any).me(LP_ADDR);

    expect(me).not.toBeNull();
    expect((me as any).reachable).toBe(true);
    expect(me).not.toHaveProperty('alertEmail');
  });

  it('11b — reports reachable: false for a provider with neither an alertEmail nor a linked Person.email, and still never the address key', async () => {
    const prisma = makePrisma(null);

    const me = await new LpService(prisma, {} as any).me(LP_ADDR);

    expect(me).not.toBeNull();
    expect((me as any).reachable).toBe(false);
    expect(me).not.toHaveProperty('alertEmail');
  });

  it("11c — reports reachable: true for a provider with alertEmail NULL and a linked Person.email SET, the disjunction's third case, and still never exposes alertEmail", async () => {
    const prisma = makePrisma(null, 'linked-person@example.test');

    const me = await new LpService(prisma, {} as any).me(LP_ADDR);

    expect(me).not.toBeNull();
    expect((me as any).reachable).toBe(true);
    expect(me).not.toHaveProperty('alertEmail');
  });
});
