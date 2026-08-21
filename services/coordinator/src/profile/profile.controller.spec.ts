import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import request from 'supertest';

import { ProfileController } from './profile.controller';
import { UserReputationService } from '../reputation/user-reputation.service';
import { PrismaService } from '../prisma/prisma.service';

const ADDR = 'GBSYTTNQVWKH2DOIWXSE6UVJXRCUIXKSC5TBPYWNLCXLS35FKH7DNOHT';
const USDC = 10_000_000n;

describe('ProfileController — GET /profile', () => {
  let app: INestApplication;

  const mockUserReputation = {
    getReputation: jest.fn(),
    dailyLimitBaseUnits: jest.fn(),
    used24hBaseUnits: jest.fn(),
  };
  const mockPrisma = {
    config: { findUnique: jest.fn() },
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [ProfileController],
      providers: [
        { provide: UserReputationService, useValue: mockUserReputation },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { address: ADDR, role: 'user' };
          return true;
        },
      })
      .overrideGuard(require('../auth/roles.guard').RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('serializes tier/reputation/limit fields in snake_case, using req.user.address', async () => {
    mockUserReputation.getReputation.mockResolvedValue({
      tier: 'SILVER',
      completedTrades: 7,
      disputesLost: 0,
      completionRate: 1,
    });
    mockPrisma.config.findUnique.mockResolvedValue({ dailyLimitByTier: null });
    mockUserReputation.dailyLimitBaseUnits.mockReturnValue(300n * USDC);
    mockUserReputation.used24hBaseUnits.mockResolvedValue(50n * USDC);

    const res = await request(app.getHttpServer())
      .get('/profile')
      .set('Authorization', 'Bearer user')
      .expect(200);

    expect(mockUserReputation.getReputation).toHaveBeenCalledWith(ADDR);
    expect(mockUserReputation.used24hBaseUnits).toHaveBeenCalledWith(ADDR);
    expect(mockUserReputation.dailyLimitBaseUnits).toHaveBeenCalledWith('SILVER', {
      dailyLimitByTier: null,
    });
    expect(res.body).toEqual({
      tier: 'SILVER',
      completed_trades: 7,
      disputes_lost: 0,
      completion_rate: 1,
      daily_limit_usdc: 300,
      daily_used_usdc: 50,
      daily_remaining_usdc: 250,
    });
  });

  it('floors daily_remaining_usdc at 0 when used exceeds the (possibly lowered) limit', async () => {
    mockUserReputation.getReputation.mockResolvedValue({
      tier: 'BRONZE',
      completedTrades: 0,
      disputesLost: 2,
      completionRate: 0,
    });
    mockPrisma.config.findUnique.mockResolvedValue(null);
    mockUserReputation.dailyLimitBaseUnits.mockReturnValue(100n * USDC);
    mockUserReputation.used24hBaseUnits.mockResolvedValue(150n * USDC);

    const res = await request(app.getHttpServer())
      .get('/profile')
      .set('Authorization', 'Bearer user')
      .expect(200);

    expect(res.body.daily_remaining_usdc).toBe(0);
    expect(res.body.daily_used_usdc).toBe(150);
  });

  it('completion_rate is null for a brand-new user with no concluded trades', async () => {
    mockUserReputation.getReputation.mockResolvedValue({
      tier: 'BRONZE',
      completedTrades: 0,
      disputesLost: 0,
      completionRate: null,
    });
    mockPrisma.config.findUnique.mockResolvedValue(null);
    mockUserReputation.dailyLimitBaseUnits.mockReturnValue(100n * USDC);
    mockUserReputation.used24hBaseUnits.mockResolvedValue(0n);

    const res = await request(app.getHttpServer())
      .get('/profile')
      .set('Authorization', 'Bearer user')
      .expect(200);

    expect(res.body.completion_rate).toBeNull();
    expect(res.body.daily_limit_usdc).toBe(100);
    expect(res.body.daily_used_usdc).toBe(0);
    expect(res.body.daily_remaining_usdc).toBe(100);
  });

  it('converts a fractional 24h-used amount to decimal USDC correctly', async () => {
    mockUserReputation.getReputation.mockResolvedValue({
      tier: 'GOLD',
      completedTrades: 60,
      disputesLost: 0,
      completionRate: 1,
    });
    mockPrisma.config.findUnique.mockResolvedValue(null);
    mockUserReputation.dailyLimitBaseUnits.mockReturnValue(2000n * USDC);
    mockUserReputation.used24hBaseUnits.mockResolvedValue(12_3456789n);

    const res = await request(app.getHttpServer())
      .get('/profile')
      .set('Authorization', 'Bearer user')
      .expect(200);

    expect(res.body.daily_used_usdc).toBeCloseTo(12.3456789, 7);
  });
});
