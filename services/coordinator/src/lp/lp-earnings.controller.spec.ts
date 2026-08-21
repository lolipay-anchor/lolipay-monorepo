import { Test } from '@nestjs/testing';
import { ExecutionContext, INestApplication } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import request from 'supertest';

import { LpController } from './lp.controller';
import { LpService, LpEarnings } from './lp.service';
import { RolesGuard } from '../auth/roles.guard';

const LP_ADDR = 'GLPWALLET';

const FAKE_EARNINGS: LpEarnings = {
  todayTrades: 3,
  todayEarnedUsdc: 1.8,
  todayVolumeUsdc: 150,
  weekBars: [
    { date: '2026-07-02', volumeUsdc: 0, earnedUsdc: 0 },
    { date: '2026-07-03', volumeUsdc: 0, earnedUsdc: 0 },
    { date: '2026-07-04', volumeUsdc: 0, earnedUsdc: 0 },
    { date: '2026-07-05', volumeUsdc: 20, earnedUsdc: 0.2 },
    { date: '2026-07-06', volumeUsdc: 0, earnedUsdc: 0 },
    { date: '2026-07-07', volumeUsdc: 0, earnedUsdc: 0 },
    { date: '2026-07-08', volumeUsdc: 150, earnedUsdc: 1.8 },
  ],
  allTimeTrades: 42,
  allTimeEarnedUsdc: 5,
};

const mockLpService = {
  getEarnings: jest.fn(),

  apply: jest.fn(),
  me: jest.fn(),
  heartbeat: jest.fn(),
  setAvailability: jest.fn(),
  addPaymentMethod: jest.fn(),
  updatePaymentMethod: jest.fn(),
  deletePaymentMethod: jest.fn(),
  buildStakeTx: jest.fn(),
  buildRequestUnstakeTx: jest.fn(),
  buildClaimUnstakeTx: jest.fn(),
  getStakeInfo: jest.fn(),
  assignableLps: jest.fn(),
};

describe('GET /lp/earnings (HTTP controller, real RolesGuard)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [LpController],
      providers: [{ provide: LpService, useValue: mockLpService }, Reflector, RolesGuard],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest();
          const role = req.headers['x-test-role'] ?? 'lp';
          req.user = { address: LP_ADDR, role };
          return true;
        },
      })
      .compile();

    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('LP caller → 200 with the snake_case LpEarnings shape', async () => {
    mockLpService.getEarnings.mockResolvedValue(FAKE_EARNINGS);

    const res = await request(app.getHttpServer())
      .get('/lp/earnings')
      .set('x-test-role', 'lp')
      .expect(200);

    expect(mockLpService.getEarnings).toHaveBeenCalledWith(LP_ADDR);
    expect(res.body).toEqual({
      today_trades: 3,
      today_earned_usdc: 1.8,
      today_volume_usdc: 150,
      week_bars: [
        { date: '2026-07-02', volume_usdc: 0, earned_usdc: 0 },
        { date: '2026-07-03', volume_usdc: 0, earned_usdc: 0 },
        { date: '2026-07-04', volume_usdc: 0, earned_usdc: 0 },
        { date: '2026-07-05', volume_usdc: 20, earned_usdc: 0.2 },
        { date: '2026-07-06', volume_usdc: 0, earned_usdc: 0 },
        { date: '2026-07-07', volume_usdc: 0, earned_usdc: 0 },
        { date: '2026-07-08', volume_usdc: 150, earned_usdc: 1.8 },
      ],
      all_time_trades: 42,
      all_time_earned_usdc: 5,
    });
  });

  it('non-LP role (user) → 403, LpService.getEarnings never called', async () => {
    await request(app.getHttpServer())
      .get('/lp/earnings')
      .set('x-test-role', 'user')
      .expect(403);

    expect(mockLpService.getEarnings).not.toHaveBeenCalled();
  });

  it('non-LP role (admin) → 403 (admin does not implicitly get LP earnings)', async () => {
    await request(app.getHttpServer())
      .get('/lp/earnings')
      .set('x-test-role', 'admin')
      .expect(403);

    expect(mockLpService.getEarnings).not.toHaveBeenCalled();
  });

  it("propagates LpService's NotFoundException (address resolved to no Lp row) as 404", async () => {
    const { NotFoundException } = await import('@nestjs/common');
    mockLpService.getEarnings.mockRejectedValue(new NotFoundException('LP not found'));

    await request(app.getHttpServer())
      .get('/lp/earnings')
      .set('x-test-role', 'lp')
      .expect(404);
  });

  it('empty/zeroed LpEarnings → 200 with zeros/7-entry array, not nulls', async () => {
    mockLpService.getEarnings.mockResolvedValue({
      todayTrades: 0,
      todayEarnedUsdc: 0,
      todayVolumeUsdc: 0,
      weekBars: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-07-0${i + 2}`,
        volumeUsdc: 0,
        earnedUsdc: 0,
      })),
      allTimeTrades: 0,
      allTimeEarnedUsdc: 0,
    } satisfies LpEarnings);

    const res = await request(app.getHttpServer())
      .get('/lp/earnings')
      .set('x-test-role', 'lp')
      .expect(200);

    expect(res.body.today_trades).toBe(0);
    expect(res.body.today_earned_usdc).toBe(0);
    expect(res.body.week_bars).toHaveLength(7);
    expect(res.body.all_time_trades).toBe(0);
    expect(res.body.week_bars.every((b: any) => b.volume_usdc === 0 && b.earned_usdc === 0)).toBe(true);
  });
});
