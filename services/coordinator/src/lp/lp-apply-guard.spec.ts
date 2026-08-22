import { BadRequestException } from '@nestjs/common';
import { LpService } from './lp.service';

describe('LpService.apply — trustline guard', () => {
  const ADDR = 'GLPWALLET';

  function makeSvc(hasTrustline: boolean) {
    const prisma = {
      lp: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'lp1', stellarAddress: ADDR, status: 'PENDING' }),
        update: jest.fn().mockResolvedValue({ id: 'lp1', stellarAddress: ADDR, status: 'PENDING' }),
      },
    } as any;
    const stellar = { hasUsdcTrustline: jest.fn().mockResolvedValue(hasTrustline) } as any;
    return { svc: new LpService(prisma, stellar), prisma, stellar };
  }

  it('rejects the application when the LP wallet lacks a USDC trustline', async () => {
    const { svc, prisma, stellar } = makeSvc(false);
    await expect(svc.apply(ADDR, 'a@b.co', 'proof')).rejects.toBeInstanceOf(BadRequestException);
    expect(stellar.hasUsdcTrustline).toHaveBeenCalledWith(ADDR);
    expect(prisma.lp.create).not.toHaveBeenCalled();
    expect(prisma.lp.update).not.toHaveBeenCalled();
  });

  it('accepts the application (creates PENDING) when the LP wallet trusts USDC', async () => {
    const { svc, prisma } = makeSvc(true);
    const lp = await svc.apply(ADDR, 'a@b.co', 'proof');
    expect(lp.status).toBe('PENDING');
    expect(prisma.lp.create).toHaveBeenCalled();
  });
});
