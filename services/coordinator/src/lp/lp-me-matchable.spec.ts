import { LpService } from './lp.service';
import { matchableLpWhere } from '../matching/matching.service';

const LP_ADDR = 'GLPWALLET';
const NOW = new Date('2026-09-14T10:00:00.000Z');

const ROW = {
  id: 'lp1',
  stellarAddress: LP_ADDR,
  status: 'APPROVED',
  contact: 'provider@example.test',
  liquidityProof: 'proof',
  online: true,
  lastHeartbeatAt: NOW,
  createdAt: NOW,
  approvedAt: NOW,
  paymentMethods: [{ id: 'pm1', rail: 'BANK', active: true }],
};

function makePrisma(row: any, matchableCount: number) {
  return {
    lp: {
      findUnique: jest.fn().mockResolvedValue(row),
      count: jest.fn().mockResolvedValue(matchableCount),
    },
  } as any;
}

describe('LpService.me — the provider is told whether orders can reach them', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('asks the database the SHARED matchability rule for this one provider, so the badge cannot drift from the matcher that picks them', async () => {
    const prisma = makePrisma(ROW, 1);

    await new LpService(prisma, {} as any).me(LP_ADDR);

    expect(prisma.lp.count).toHaveBeenCalledTimes(1);
    expect(prisma.lp.count).toHaveBeenCalledWith({ where: { ...matchableLpWhere(), id: 'lp1' } });
  });

  it('reports matchable true when the shared rule counts this provider, and changes nothing else in the response', async () => {
    const prisma = makePrisma(ROW, 1);

    const me = await new LpService(prisma, {} as any).me(LP_ADDR);

    expect(me).toEqual({ ...ROW, matchable: true });
  });

  it('reports matchable false when the shared rule does not count this provider, and changes nothing else in the response', async () => {
    const prisma = makePrisma(ROW, 0);

    const me = await new LpService(prisma, {} as any).me(LP_ADDR);

    expect(me).toEqual({ ...ROW, matchable: false });
  });

  it('returns null for a wallet that is not a provider, and never asks the matchability question', async () => {
    const prisma = makePrisma(null, 0);

    const me = await new LpService(prisma, {} as any).me(LP_ADDR);

    expect(me).toBeNull();
    expect(prisma.lp.count).not.toHaveBeenCalled();
  });
});
