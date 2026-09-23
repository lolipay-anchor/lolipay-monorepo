import { LpService } from './lp.service';

const LP_ADDR = 'GLPWALLET';

function makePrisma(alertEmail: string | null) {
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
      }),
      count: jest.fn().mockResolvedValue(0),
    },
  } as any;
}

describe('LpService.me — ADR 0054: the alert address is never served back over GET /lp/me', () => {
  it('11a — reports alertEmailSet: true and never the address itself, for a provider with alertEmail on file', async () => {
    const prisma = makePrisma('ops@example.com');

    const me = await new LpService(prisma, {} as any).me(LP_ADDR);

    expect(me).not.toBeNull();
    expect((me as any).alertEmailSet).toBe(true);
    expect(me).not.toHaveProperty('alertEmail');
  });

  it('11b — reports alertEmailSet: false for a provider with no address on file, and still never the address key', async () => {
    const prisma = makePrisma(null);

    const me = await new LpService(prisma, {} as any).me(LP_ADDR);

    expect(me).not.toBeNull();
    expect((me as any).alertEmailSet).toBe(false);
    expect(me).not.toHaveProperty('alertEmail');
  });
});
