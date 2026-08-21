import { LpService } from './lp.service';

const LP_ADDR = 'GLPWALLET';

function makePrisma() {
  return {
    lp: {
      update: jest.fn().mockResolvedValue(undefined),
    },
  } as any;
}

function makeSvc(prisma: any) {
  return new LpService(prisma, {} as any);
}

describe('LpService.heartbeat', () => {
  it('bumps ONLY lastHeartbeatAt — never writes `online`', async () => {
    const prisma = makePrisma();
    const svc = makeSvc(prisma);

    await svc.heartbeat(LP_ADDR);

    expect(prisma.lp.update).toHaveBeenCalledTimes(1);
    expect(prisma.lp.update).toHaveBeenCalledWith({
      where: { stellarAddress: LP_ADDR },
      data: { lastHeartbeatAt: expect.any(Date) },
    });
    const call = (prisma.lp.update as jest.Mock).mock.calls[0][0];
    expect(call.data).not.toHaveProperty('online');
  });
});

describe('LpService.setAvailability', () => {
  it('is the sole writer of `online` — turning ON writes online:true and nothing else', async () => {
    const prisma = makePrisma();
    const svc = makeSvc(prisma);

    await svc.setAvailability(LP_ADDR, true);

    expect(prisma.lp.update).toHaveBeenCalledWith({
      where: { stellarAddress: LP_ADDR },
      data: { online: true },
    });
  });

  it('turning OFF writes online:false and never touches lastHeartbeatAt', async () => {
    const prisma = makePrisma();
    const svc = makeSvc(prisma);

    await svc.setAvailability(LP_ADDR, false);

    const call = (prisma.lp.update as jest.Mock).mock.calls[0][0];
    expect(call.data).toEqual({ online: false });
    expect(call.data).not.toHaveProperty('lastHeartbeatAt');
  });
});

