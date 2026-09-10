import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import request from 'supertest';
import { Account, Keypair, Networks, StrKey } from '@stellar/stellar-sdk';

import { StellarReadService } from '../stellar/stellar-read.service';
import { LpService } from './lp.service';
import { LpController } from './lp.controller';

const LP_KP = Keypair.random();
const LP_ADDR = LP_KP.publicKey();
const FAKE_CONTRACT = StrKey.encodeContract(Buffer.alloc(32));
const SENTINEL_XDR = 'BBBBB-sentinel-stake-xdr-BBBBB';
const FAKE_PASSPHRASE = Networks.TESTNET;

const FAKE_STAKE_INFO = {
  staked: '1000000000',
  unbonding: '0',
  unbond_available_at: 0,
  min_stake: '500000000',
  eligible: true,
};

describe('StellarReadService.buildStakeTx (unit, mocked RPC server)', () => {
  function makeSvc() {
    return new StellarReadService({
      rpcUrl: 'http://fake-rpc',
      networkPassphrase: FAKE_PASSPHRASE,
      escrowContractId: FAKE_CONTRACT,
      stakingContractId: FAKE_CONTRACT,
    } as any);
  }

  const fakeAccount = new Account(LP_ADDR, '100');
  const fakePreparedTx = { toXdr: () => SENTINEL_XDR };

  it('happy path: returns { xdr, networkPassphrase } from prepareTransaction', async () => {
    const svc = makeSvc();
    const mockServer = {
      getAccount: jest.fn().mockResolvedValue(fakeAccount),
      prepareTransaction: jest.fn().mockResolvedValue(fakePreparedTx),
    };
    (svc as any).createRpcServer = () => mockServer;

    const result = await svc.buildStakeTx(LP_ADDR, '1000000000');

    expect(mockServer.getAccount).toHaveBeenCalledWith(LP_ADDR);
    expect(mockServer.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE });
  });

  it('throws Error when getAccount fails (account not funded or RPC down)', async () => {
    const svc = makeSvc();
    const mockServer = {
      getAccount: jest.fn().mockRejectedValue(new Error('account not found')),
      prepareTransaction: jest.fn(),
    };
    (svc as any).createRpcServer = () => mockServer;

    await expect(svc.buildStakeTx(LP_ADDR, '1000000000')).rejects.toThrow(
      /could not load account/i,
    );
    expect(mockServer.prepareTransaction).not.toHaveBeenCalled();
  });

  it('throws Error when prepareTransaction fails (simulation error)', async () => {
    const svc = makeSvc();
    const mockServer = {
      getAccount: jest.fn().mockResolvedValue(fakeAccount),
      prepareTransaction: jest.fn().mockRejectedValue(new Error('simulation failed')),
    };
    (svc as any).createRpcServer = () => mockServer;

    await expect(svc.buildStakeTx(LP_ADDR, '1000000000')).rejects.toThrow(
      /prepareTransaction failed/i,
    );
  });
});

describe('StellarReadService.getStakeInfo (unit, mocked simulateCall)', () => {
  function makeSvc() {
    return new StellarReadService({
      rpcUrl: 'http://fake-rpc',
      networkPassphrase: FAKE_PASSPHRASE,
      escrowContractId: FAKE_CONTRACT,
      stakingContractId: FAKE_CONTRACT,
    } as any);
  }

  it('decodes i128 (BigInt) staked/unbonding/min_stake as decimal strings and u64 as number', async () => {
    const svc = makeSvc();

    (svc as any).simulateCall = jest
      .fn()
      .mockResolvedValueOnce({ staked: BigInt('1000000000'), unbonding: BigInt('0'), unbond_available_at: BigInt('0') })
      .mockResolvedValueOnce({ min_stake: BigInt('500000000'), cooldown_secs: BigInt('604800'), paused: false })
      .mockResolvedValueOnce(true);

    const result = await svc.getStakeInfo(LP_ADDR);

    expect(result).toEqual({
      staked: '1000000000',
      unbonding: '0',
      unbond_available_at: 0,
      min_stake: '500000000',
      eligible: true,
    });
  });

  it('handles uninitialised LP (all zeros from contract default)', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = jest
      .fn()
      .mockResolvedValueOnce({ staked: BigInt(0), unbonding: BigInt(0), unbond_available_at: BigInt(0) })
      .mockResolvedValueOnce({ min_stake: BigInt('500000000'), cooldown_secs: BigInt('604800'), paused: false })
      .mockResolvedValueOnce(false);

    const result = await svc.getStakeInfo(LP_ADDR);

    expect(result.staked).toBe('0');
    expect(result.unbonding).toBe('0');
    expect(result.eligible).toBe(false);
  });

  it('propagates RPC error from simulateCall', async () => {
    const svc = makeSvc();
    (svc as any).simulateCall = jest.fn().mockRejectedValue(new Error('RPC timeout'));

    await expect(svc.getStakeInfo(LP_ADDR)).rejects.toThrow(/RPC timeout/);
  });

  it('handles non-zero unbond_available_at timestamp as number', async () => {
    const svc = makeSvc();
    const timestamp = 1750000000;
    (svc as any).simulateCall = jest
      .fn()
      .mockResolvedValueOnce({
        staked: BigInt('2000000000'),
        unbonding: BigInt('500000000'),
        unbond_available_at: BigInt(timestamp),
      })
      .mockResolvedValueOnce({ min_stake: BigInt('500000000'), cooldown_secs: BigInt('604800'), paused: false })
      .mockResolvedValueOnce(true);

    const result = await svc.getStakeInfo(LP_ADDR);

    expect(result.unbond_available_at).toBe(timestamp);
    expect(typeof result.unbond_available_at).toBe('number');
  });
});

describe('LpService staking wrappers (unit)', () => {
  function makeSvc(stellarOverrides: Partial<any> = {}) {
    const stellar: any = {
      buildStakeTx: jest.fn().mockResolvedValue({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE }),
      getStakeInfo: jest.fn().mockResolvedValue(FAKE_STAKE_INFO),
      ...stellarOverrides,
    };

    const prisma = {
      lp: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn(), findMany: jest.fn() },
      paymentMethod: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), delete: jest.fn() },
    } as any;
    return new LpService(prisma, stellar);
  }

  it('buildStakeTx happy path → delegates to StellarReadService', async () => {
    const svc = makeSvc();
    const result = await svc.buildStakeTx(LP_ADDR, '1000000000');
    expect(result).toEqual({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE });
  });

  it('buildStakeTx RPC error → ServiceUnavailableException (no leak)', async () => {
    const svc = makeSvc({
      buildStakeTx: jest.fn().mockRejectedValue(new Error('prepareTransaction failed: timeout')),
    });
    await expect(svc.buildStakeTx(LP_ADDR, '1000000000')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('getStakeInfo happy path → delegates to StellarReadService', async () => {
    const svc = makeSvc();
    const result = await svc.getStakeInfo(LP_ADDR);
    expect(result).toEqual(FAKE_STAKE_INFO);
  });

  it('getStakeInfo RPC error → ServiceUnavailableException (no leak)', async () => {
    const svc = makeSvc({
      getStakeInfo: jest.fn().mockRejectedValue(new Error('RPC unavailable')),
    });
    await expect(svc.getStakeInfo(LP_ADDR)).rejects.toThrow(ServiceUnavailableException);
  });

  it('buildStakeTx RPC error → exact safe message "Stellar RPC unavailable, retry later" (H1)', async () => {
    const rawDetail = 'prepareTransaction failed: connection refused to 10.0.0.1:8000';
    const svc = makeSvc({
      buildStakeTx: jest.fn().mockRejectedValue(new Error(rawDetail)),
    });
    let err: any;
    try { await svc.buildStakeTx(LP_ADDR, '1000000000'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      message: 'Stellar RPC unavailable, retry later',
    });
  });

  it('getStakeInfo RPC error → exact safe message "Stellar RPC unavailable, retry later" (H1)', async () => {
    const rawDetail = 'RPC down: DB connection failed at 10.0.0.1:5432';
    const svc = makeSvc({
      getStakeInfo: jest.fn().mockRejectedValue(new Error(rawDetail)),
    });
    let err: any;
    try { await svc.getStakeInfo(LP_ADDR); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      message: 'Stellar RPC unavailable, retry later',
    });
  });
});

describe('GET /lp/tx/stake + GET /lp/eligibility (HTTP controller)', () => {
  let app: INestApplication;

  const mockLpService = {
    buildStakeTx: jest.fn(),
    getStakeInfo: jest.fn(),

    apply: jest.fn(),
    me: jest.fn(),
    heartbeat: jest.fn(),
    setAvailability: jest.fn(),
    addPaymentMethod: jest.fn(),
    updatePaymentMethod: jest.fn(),
    deletePaymentMethod: jest.fn(),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [LpController],
      providers: [{ provide: LpService, useValue: mockLpService }],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { address: LP_ADDR, role: 'lp' };
          return true;
        },
      })
      .overrideGuard(require('../auth/roles.guard').RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('(a) valid amount → 200 { xdr, networkPassphrase }', async () => {
    mockLpService.buildStakeTx.mockResolvedValue({
      xdr: SENTINEL_XDR,
      networkPassphrase: FAKE_PASSPHRASE,
    });

    const res = await request(app.getHttpServer())
      .get('/lp/tx/stake?amount=1000000000')
      .expect(200);

    expect(res.body.xdr).toBe(SENTINEL_XDR);
    expect(res.body.networkPassphrase).toBe(FAKE_PASSPHRASE);
    expect(mockLpService.buildStakeTx).toHaveBeenCalledWith(LP_ADDR, '1000000000');
  });

  it('(b) missing amount → 400', async () => {
    await request(app.getHttpServer())
      .get('/lp/tx/stake')
      .expect(400);
  });

  it('(c) zero amount → 400', async () => {
    await request(app.getHttpServer())
      .get('/lp/tx/stake?amount=0')
      .expect(400);
  });

  it('(d) negative amount → 400', async () => {
    await request(app.getHttpServer())
      .get('/lp/tx/stake?amount=-100')
      .expect(400);
  });

  it('(e) decimal amount → 400', async () => {
    await request(app.getHttpServer())
      .get('/lp/tx/stake?amount=1.5')
      .expect(400);
  });

  it('(f) non-numeric string → 400', async () => {
    await request(app.getHttpServer())
      .get('/lp/tx/stake?amount=abc')
      .expect(400);
  });

  it('(g) RPC unavailable → 503', async () => {
    mockLpService.buildStakeTx.mockRejectedValue(
      new ServiceUnavailableException('Stellar RPC unavailable'),
    );

    await request(app.getHttpServer())
      .get('/lp/tx/stake?amount=1000000000')
      .expect(503);
  });

  it('(h) GET /lp/eligibility → 200 with eligibility object', async () => {
    mockLpService.getStakeInfo.mockResolvedValue(FAKE_STAKE_INFO);

    const res = await request(app.getHttpServer())
      .get('/lp/eligibility')
      .expect(200);

    expect(res.body).toEqual(FAKE_STAKE_INFO);
    expect(mockLpService.getStakeInfo).toHaveBeenCalledWith(LP_ADDR);
  });

  it('(i) GET /lp/eligibility with eligible=false → 200 eligible:false', async () => {
    mockLpService.getStakeInfo.mockResolvedValue({
      ...FAKE_STAKE_INFO,
      staked: '0',
      eligible: false,
    });

    const res = await request(app.getHttpServer())
      .get('/lp/eligibility')
      .expect(200);

    expect(res.body.eligible).toBe(false);
  });

  it('(j) GET /lp/eligibility RPC error → 503', async () => {
    mockLpService.getStakeInfo.mockRejectedValue(
      new ServiceUnavailableException('Stellar RPC unavailable'),
    );

    await request(app.getHttpServer())
      .get('/lp/eligibility')
      .expect(503);
  });
});
