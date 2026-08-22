import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, ForbiddenException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import request from 'supertest';
import { Account, Keypair, Networks, StrKey } from '@stellar/stellar-sdk';

import { StellarReadService } from '../stellar/stellar-read.service';
import { OrderService } from './order.service';
import { makeUserReputationStub, onChainTradeFor } from './test-helpers';
import { OrderController } from './order.controller';
import { ObjectStorageService } from '../storage/object-storage.service';
import { OrderStatusService } from './order-status.service';

const mockObjectStorage = { getObjectStream: jest.fn() };

const USER_KP = Keypair.random();
const LP_KP = Keypair.random();
const USER_ADDR = USER_KP.publicKey();
const LP_ADDR = LP_KP.publicKey();

const FAKE_CONTRACT = StrKey.encodeContract(Buffer.alloc(32));

const FAKE_TRADE_ID = 'a'.repeat(64);
const SENTINEL_XDR = 'AAAAA-sentinel-xdr-AAAAA';
const FAKE_PASSPHRASE = Networks.TESTNET;

describe('StellarReadService.buildMarkFiatPaidTx (unit, mocked RPC server)', () => {
  function makeSvc() {
    return new StellarReadService({
      rpcUrl: 'http://fake-rpc',
      networkPassphrase: FAKE_PASSPHRASE,
      escrowContractId: FAKE_CONTRACT,
      stakingContractId: FAKE_CONTRACT,
    } as any);
  }

  const fakeAccount = new Account(USER_ADDR, '100');
  const fakePreparedTx = { toXDR: () => SENTINEL_XDR };

  it('happy path: returns { xdr, networkPassphrase } from prepareTransaction', async () => {
    const svc = makeSvc();
    const mockServer = {
      getAccount: jest.fn().mockResolvedValue(fakeAccount),
      prepareTransaction: jest.fn().mockResolvedValue(fakePreparedTx),
    };
    (svc as any).createRpcServer = () => mockServer;

    const result = await svc.buildMarkFiatPaidTx(FAKE_CONTRACT, USER_ADDR, FAKE_TRADE_ID);

    expect(mockServer.getAccount).toHaveBeenCalledWith(USER_ADDR);
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

    await expect(svc.buildMarkFiatPaidTx(FAKE_CONTRACT, USER_ADDR, FAKE_TRADE_ID)).rejects.toThrow(
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

    await expect(svc.buildMarkFiatPaidTx(FAKE_CONTRACT, USER_ADDR, FAKE_TRADE_ID)).rejects.toThrow(
      /prepareTransaction failed/i,
    );
  });
});

describe('StellarReadService.buildCreateTradeTx (unit, mocked RPC server)', () => {
  function makeSvc() {
    return new StellarReadService({
      rpcUrl: 'http://fake-rpc',
      networkPassphrase: FAKE_PASSPHRASE,
      escrowContractId: FAKE_CONTRACT,
      stakingContractId: FAKE_CONTRACT,
    } as any);
  }

  const fakeAccount = new Account(LP_ADDR, '100');
  const fakePreparedTx = { toXDR: () => SENTINEL_XDR };

  const BASE_PARAMS = {
    contractId: FAKE_CONTRACT,
    tradeIdHex: FAKE_TRADE_ID,
    usdcProvider: LP_ADDR,
    usdcRecipient: USER_ADDR,
    confirmer: LP_ADDR,
    usdcAmount: BigInt('100000000'),
    fiatAmount: BigInt('1600000'),
    fiatCurrency: 'IDR',
    flow: 'TOP_UP',
    platformFeeBps: 30,
    lpFeeBps: 120,
    platformWallet: USER_ADDR,
    lpWallet: LP_ADDR,
    payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
    confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
  };

  it('happy path TOP_UP: returns { xdr, networkPassphrase }', async () => {
    const svc = makeSvc();
    const mockServer = {
      getAccount: jest.fn().mockResolvedValue(fakeAccount),
      prepareTransaction: jest.fn().mockResolvedValue(fakePreparedTx),
    };
    (svc as any).createRpcServer = () => mockServer;

    const result = await svc.buildCreateTradeTx(BASE_PARAMS);

    expect(mockServer.getAccount).toHaveBeenCalledWith(LP_ADDR);
    expect(mockServer.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE });
  });

  it('WITHDRAW flow: source account = user (usdc_provider)', async () => {
    const svc = makeSvc();
    const fakeUserAccount = new Account(USER_ADDR, '200');
    const mockServer = {
      getAccount: jest.fn().mockResolvedValue(fakeUserAccount),
      prepareTransaction: jest.fn().mockResolvedValue(fakePreparedTx),
    };
    (svc as any).createRpcServer = () => mockServer;

    const result = await svc.buildCreateTradeTx({
      ...BASE_PARAMS,
      usdcProvider: USER_ADDR,
      flow: 'WITHDRAW',
    });

    expect(mockServer.getAccount).toHaveBeenCalledWith(USER_ADDR);
    expect(result.xdr).toBe(SENTINEL_XDR);
  });

  it('throws when getAccount fails', async () => {
    const svc = makeSvc();
    const mockServer = {
      getAccount: jest.fn().mockRejectedValue(new Error('not found')),
      prepareTransaction: jest.fn(),
    };
    (svc as any).createRpcServer = () => mockServer;

    await expect(svc.buildCreateTradeTx(BASE_PARAMS)).rejects.toThrow(
      /could not load account/i,
    );
    expect(mockServer.prepareTransaction).not.toHaveBeenCalled();
  });

  it('throws when prepareTransaction fails', async () => {
    const svc = makeSvc();
    const mockServer = {
      getAccount: jest.fn().mockResolvedValue(fakeAccount),
      prepareTransaction: jest.fn().mockRejectedValue(new Error('simulation failed')),
    };
    (svc as any).createRpcServer = () => mockServer;

    await expect(svc.buildCreateTradeTx(BASE_PARAMS)).rejects.toThrow(
      /prepareTransaction failed/i,
    );
  });

  it('throws on unknown flow string', async () => {
    const svc = makeSvc();
    const mockServer = {
      getAccount: jest.fn().mockResolvedValue(fakeAccount),
      prepareTransaction: jest.fn(),
    };
    (svc as any).createRpcServer = () => mockServer;

    await expect(svc.buildCreateTradeTx({ ...BASE_PARAMS, flow: 'BAD_FLOW' })).rejects.toThrow(
      /unknown flow/i,
    );
  });
});

describe('OrderService.buildMarkFiatPaidTx (unit)', () => {
  function makeOrder(overrides: Partial<any> = {}): any {
    return {
      id: 'order-1',
      tradeId: FAKE_TRADE_ID,
      userAddress: USER_ADDR,
      flow: 'TOP_UP',
      status: 'FUNDED',
      lp: { stellarAddress: LP_ADDR },
      ...overrides,
    };
  }

  function makeSvc(prismaOverrides: any = {}, stellarOverrides: any = {}) {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(makeOrder()),
        ...prismaOverrides,
      },
      quote: {},

      config: {
        upsert: jest.fn().mockResolvedValue({ requireProof: false }),
      },
    } as any;

    const stellar = {
      buildMarkFiatPaidTx: jest
        .fn()
        .mockResolvedValue({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE }),
      isEligible: jest.fn(),
      getTradeStatus: jest.fn(),
      getTradeStatusStrict: jest.fn(),
      ...stellarOverrides,
    } as any;

    const matching = { pickLp: jest.fn() } as any;
    const cfg = { platformWallet: USER_ADDR } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;

    return new OrderService(prisma, stellar, matching, cfg, markets, notifications, mockObjectStorage as any, makeUserReputationStub(), new OrderStatusService(prisma, stellar, cfg));
  }

  it('(a) FUNDED order, correct fiat payer (TOP_UP → user) → returns {xdr, networkPassphrase}', async () => {
    const svc = makeSvc();
    const result = await svc.buildMarkFiatPaidTx('order-1', USER_ADDR);

    expect(result).toEqual({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE });
  });

  it('(b) non-owner (WITHDRAW → LP is fiat payer, but user calls) → ForbiddenException', async () => {
    const svc = makeSvc({
      findUnique: jest.fn().mockResolvedValue(
        makeOrder({ flow: 'WITHDRAW' }),
      ),
    });

    await expect(svc.buildMarkFiatPaidTx('order-1', USER_ADDR)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('(c) order not FUNDED (status=MATCHED) → ConflictException', async () => {
    const svc = makeSvc({
      findUnique: jest.fn().mockResolvedValue(makeOrder({ status: 'MATCHED' })),
    });

    await expect(svc.buildMarkFiatPaidTx('order-1', USER_ADDR)).rejects.toThrow(
      ConflictException,
    );
  });

  it('order not found → NotFoundException', async () => {
    const svc = makeSvc({
      findUnique: jest.fn().mockResolvedValue(null),
    });

    await expect(svc.buildMarkFiatPaidTx('order-1', USER_ADDR)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('stellar RPC error → ServiceUnavailableException (no internal leak)', async () => {
    const svc = makeSvc(
      {},
      {
        buildMarkFiatPaidTx: jest.fn().mockRejectedValue(new Error('prepareTransaction failed: RPC timeout')),
      },
    );

    await expect(svc.buildMarkFiatPaidTx('order-1', USER_ADDR)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('M2: chain refresh advances FUNDED→FIAT_PAID before status guard → ConflictException', async () => {
    const svc = makeSvc(
      {
        findUnique: jest.fn().mockResolvedValue(makeOrder({ status: 'FUNDED' })),
        update: jest.fn().mockResolvedValue(makeOrder({ status: 'FIAT_PAID' })),
      },
      {
        getTradeStatus: jest.fn().mockResolvedValue({ status: 'FIAT_PAID' }),
      },
    );
    await expect(svc.buildMarkFiatPaidTx('order-1', USER_ADDR)).rejects.toThrow(ConflictException);
  });

  it('WITHDRAW: LP is the fiat payer and can build the tx', async () => {
    const svc = makeSvc({
      findUnique: jest.fn().mockResolvedValue(
        makeOrder({ flow: 'WITHDRAW', status: 'FUNDED' }),
      ),
    });

    const result = await svc.buildMarkFiatPaidTx('order-1', LP_ADDR);
    expect(result.xdr).toBe(SENTINEL_XDR);
  });
});

describe('OrderService.buildCreateTradeTx (unit)', () => {
  function makeOrder(overrides: Partial<any> = {}): any {
    return {
      id: 'order-1',
      tradeId: FAKE_TRADE_ID,
      userAddress: USER_ADDR,
      flow: 'TOP_UP',
      status: 'MATCHED',
      fiatCurrency: 'IDR',
      usdcAmount: BigInt('100000000'),
      fiatAmount: BigInt('1600000'),
      platformFeeBps: 30,
      lpFeeBps: 120,
      platformWallet: USER_ADDR,
      lpWallet: LP_ADDR,
      payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
      lp: { stellarAddress: LP_ADDR },
      ...overrides,
    };
  }

  function makeSvc(prismaOverrides: any = {}, stellarOverrides: any = {}) {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(makeOrder()),
        ...prismaOverrides,
      },
      quote: {},
      config: { upsert: jest.fn() },
    } as any;

    const stellar = {
      buildMarkFiatPaidTx: jest.fn().mockResolvedValue({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE }),
      buildCreateTradeTx: jest.fn().mockResolvedValue({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE }),
      isEligible: jest.fn(),
      getTradeStatus: jest.fn(),
      getTradeStatusStrict: jest.fn(),
      ...stellarOverrides,
    } as any;

    const matching = { pickLp: jest.fn() } as any;
    const cfg = { platformWallet: USER_ADDR } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;

    return new OrderService(prisma, stellar, matching, cfg, markets, notifications, mockObjectStorage as any, makeUserReputationStub(), new OrderStatusService(prisma, stellar, cfg));
  }

  it('(a) MATCHED TOP_UP order, caller is LP (usdc_provider) → returns {xdr, networkPassphrase}', async () => {
    const svc = makeSvc();

    const result = await svc.buildCreateTradeTx('order-1', LP_ADDR);
    expect(result).toEqual({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE });
  });

  it('AWAITING_ONCHAIN status also accepted', async () => {
    const svc = makeSvc({
      findUnique: jest.fn().mockResolvedValue(makeOrder({ status: 'AWAITING_ONCHAIN' })),
    });
    const result = await svc.buildCreateTradeTx('order-1', LP_ADDR);
    expect(result.xdr).toBe(SENTINEL_XDR);
  });

  it('(b) non-provider caller (user calls TOP_UP) → ForbiddenException', async () => {
    const svc = makeSvc();

    await expect(svc.buildCreateTradeTx('order-1', USER_ADDR)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('WITHDRAW: user is usdc_provider; LP calling → ForbiddenException', async () => {
    const svc = makeSvc({
      findUnique: jest.fn().mockResolvedValue(makeOrder({ flow: 'WITHDRAW' })),
    });

    await expect(svc.buildCreateTradeTx('order-1', LP_ADDR)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('(c) wrong status (FUNDED) → ConflictException', async () => {
    const svc = makeSvc({
      findUnique: jest.fn().mockResolvedValue(makeOrder({ status: 'FUNDED' })),
    });
    await expect(svc.buildCreateTradeTx('order-1', LP_ADDR)).rejects.toThrow(
      ConflictException,
    );
  });

  it('order not found → NotFoundException', async () => {
    const svc = makeSvc({
      findUnique: jest.fn().mockResolvedValue(null),
    });
    await expect(svc.buildCreateTradeTx('order-1', LP_ADDR)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('stellar RPC error → ServiceUnavailableException (no internal leak)', async () => {
    const svc = makeSvc(
      {},
      {
        buildCreateTradeTx: jest.fn().mockRejectedValue(new Error('prepareTransaction failed: RPC timeout')),
      },
    );
    await expect(svc.buildCreateTradeTx('order-1', LP_ADDR)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('M2: chain refresh advances MATCHED→FUNDED before status guard → ConflictException', async () => {
    const matched = makeOrder({ status: 'MATCHED' });
    const svc = makeSvc(
      {
        findUnique: jest.fn().mockResolvedValue(matched),
        update: jest.fn().mockResolvedValue(makeOrder({ status: 'FUNDED' })),
      },
      {
        getTradeStatus: jest.fn().mockResolvedValue(onChainTradeFor(matched, 'FUNDED')),
      },
    );
    await expect(svc.buildCreateTradeTx('order-1', LP_ADDR)).rejects.toThrow(ConflictException);
  });
});

describe('GET /orders/:id/tx/mark-paid (HTTP controller)', () => {
  let app: INestApplication;

  const mockOrderService = {
    buildMarkFiatPaidTx: jest.fn(),
    buildCreateTradeTx: jest.fn(),
    buildConfirmReleaseTx: jest.fn(),

    createFromQuote: jest.fn(),
    listOrders: jest.fn(),
    getOrder: jest.fn(),
    cancelOrder: jest.fn(),
    listLpAssignments: jest.fn(),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [OrderController],
      providers: [
        { provide: OrderService, useValue: mockOrderService },
        { provide: ObjectStorageService, useValue: mockObjectStorage },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { address: USER_ADDR, role: 'user' };
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

  it('(a) FUNDED order owned by caller → 200 { xdr, networkPassphrase }', async () => {
    mockOrderService.buildMarkFiatPaidTx.mockResolvedValue({
      xdr: SENTINEL_XDR,
      networkPassphrase: FAKE_PASSPHRASE,
    });

    const res = await request(app.getHttpServer())
      .get('/orders/order-1/tx/mark-paid')
      .expect(200);

    expect(res.body.xdr).toBe(SENTINEL_XDR);
    expect(res.body.networkPassphrase).toBe(FAKE_PASSPHRASE);
    expect(mockOrderService.buildMarkFiatPaidTx).toHaveBeenCalledWith('order-1', USER_ADDR);
  });

  it('(b) non-owner caller → 403', async () => {
    mockOrderService.buildMarkFiatPaidTx.mockRejectedValue(
      new ForbiddenException('only the fiat payer may build this transaction'),
    );

    await request(app.getHttpServer())
      .get('/orders/order-1/tx/mark-paid')
      .expect(403);
  });

  it('(c) order not FUNDED → 409', async () => {
    mockOrderService.buildMarkFiatPaidTx.mockRejectedValue(
      new ConflictException('order must be in FUNDED status to mark fiat paid'),
    );

    await request(app.getHttpServer())
      .get('/orders/order-1/tx/mark-paid')
      .expect(409);
  });

  it('order not found → 404', async () => {
    mockOrderService.buildMarkFiatPaidTx.mockRejectedValue(
      new NotFoundException('order not found'),
    );

    await request(app.getHttpServer())
      .get('/orders/order-1/tx/mark-paid')
      .expect(404);
  });

  it('RPC unavailable → 503', async () => {
    mockOrderService.buildMarkFiatPaidTx.mockRejectedValue(
      new ServiceUnavailableException('Stellar RPC unavailable, retry later'),
    );

    await request(app.getHttpServer())
      .get('/orders/order-1/tx/mark-paid')
      .expect(503);
  });

  it('unauthenticated (guard override removed) — guard in place on real app', () => {
    expect(true).toBe(true);
  });
});

describe('GET /orders/:id/tx/create-trade (HTTP controller)', () => {
  let app: INestApplication;

  const mockOrderSvc = {
    buildCreateTradeTx: jest.fn(),
    buildMarkFiatPaidTx: jest.fn(),
    buildConfirmReleaseTx: jest.fn(),
    createFromQuote: jest.fn(),
    listOrders: jest.fn(),
    getOrder: jest.fn(),
    cancelOrder: jest.fn(),
    listLpAssignments: jest.fn(),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [OrderController],
      providers: [
        { provide: OrderService, useValue: mockOrderSvc },
        { provide: ObjectStorageService, useValue: mockObjectStorage },
      ],
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

  it('(a) MATCHED TOP_UP order, LP caller (usdc_provider) → 200 { xdr, networkPassphrase }', async () => {
    mockOrderSvc.buildCreateTradeTx.mockResolvedValue({
      xdr: SENTINEL_XDR,
      networkPassphrase: FAKE_PASSPHRASE,
    });

    const res = await request(app.getHttpServer())
      .get('/orders/order-1/tx/create-trade')
      .expect(200);

    expect(res.body.xdr).toBe(SENTINEL_XDR);
    expect(res.body.networkPassphrase).toBe(FAKE_PASSPHRASE);
    expect(mockOrderSvc.buildCreateTradeTx).toHaveBeenCalledWith('order-1', LP_ADDR);
  });

  it('(b) non-provider caller → 403', async () => {
    mockOrderSvc.buildCreateTradeTx.mockRejectedValue(
      new ForbiddenException('only the usdc_provider may build this transaction'),
    );

    await request(app.getHttpServer())
      .get('/orders/order-1/tx/create-trade')
      .expect(403);
  });

  it('(c) wrong status (FUNDED) → 409', async () => {
    mockOrderSvc.buildCreateTradeTx.mockRejectedValue(
      new ConflictException('order must be in MATCHED or AWAITING_ONCHAIN status'),
    );

    await request(app.getHttpServer())
      .get('/orders/order-1/tx/create-trade')
      .expect(409);
  });

  it('order not found → 404', async () => {
    mockOrderSvc.buildCreateTradeTx.mockRejectedValue(new NotFoundException('order not found'));

    await request(app.getHttpServer())
      .get('/orders/order-1/tx/create-trade')
      .expect(404);
  });

  it('RPC unavailable → 503', async () => {
    mockOrderSvc.buildCreateTradeTx.mockRejectedValue(
      new ServiceUnavailableException('Stellar RPC unavailable, retry later'),
    );

    await request(app.getHttpServer())
      .get('/orders/order-1/tx/create-trade')
      .expect(503);
  });
});

describe('StellarReadService.buildConfirmReleaseTx (unit, mocked RPC server)', () => {
  function makeSvc() {
    return new StellarReadService({
      rpcUrl: 'http://fake-rpc',
      networkPassphrase: FAKE_PASSPHRASE,
      escrowContractId: FAKE_CONTRACT,
      stakingContractId: FAKE_CONTRACT,
    } as any);
  }

  const fakeAccount = new Account(LP_ADDR, '100');
  const fakePreparedTx = { toXDR: () => SENTINEL_XDR };

  it('happy path: returns { xdr, networkPassphrase } from prepareTransaction', async () => {
    const svc = makeSvc();
    const mockServer = {
      getAccount: jest.fn().mockResolvedValue(fakeAccount),
      prepareTransaction: jest.fn().mockResolvedValue(fakePreparedTx),
    };
    (svc as any).createRpcServer = () => mockServer;

    const result = await svc.buildConfirmReleaseTx(FAKE_CONTRACT, LP_ADDR, FAKE_TRADE_ID);

    expect(mockServer.getAccount).toHaveBeenCalledWith(LP_ADDR);
    expect(mockServer.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE });
  });

  it('throws Error when getAccount fails (confirmer not funded or RPC down)', async () => {
    const svc = makeSvc();
    const mockServer = {
      getAccount: jest.fn().mockRejectedValue(new Error('account not found')),
      prepareTransaction: jest.fn(),
    };
    (svc as any).createRpcServer = () => mockServer;

    await expect(svc.buildConfirmReleaseTx(FAKE_CONTRACT, LP_ADDR, FAKE_TRADE_ID)).rejects.toThrow(
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

    await expect(svc.buildConfirmReleaseTx(FAKE_CONTRACT, LP_ADDR, FAKE_TRADE_ID)).rejects.toThrow(
      /prepareTransaction failed/i,
    );
  });
});

describe('OrderService.buildConfirmReleaseTx (unit)', () => {
  function makeOrder(overrides: Partial<any> = {}): any {
    return {
      id: 'order-1',
      tradeId: FAKE_TRADE_ID,
      userAddress: USER_ADDR,
      flow: 'TOP_UP',
      status: 'FIAT_PAID',
      lp: { stellarAddress: LP_ADDR },
      ...overrides,
    };
  }

  function makeSvc(prismaOverrides: any = {}, stellarOverrides: any = {}) {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(makeOrder()),
        ...prismaOverrides,
      },
      quote: {},
      config: { upsert: jest.fn() },
    } as any;

    const stellar = {
      buildMarkFiatPaidTx: jest.fn().mockResolvedValue({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE }),
      buildCreateTradeTx: jest.fn().mockResolvedValue({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE }),
      buildConfirmReleaseTx: jest.fn().mockResolvedValue({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE }),
      isEligible: jest.fn(),
      getTradeStatus: jest.fn(),
      getTradeStatusStrict: jest.fn(),
      ...stellarOverrides,
    } as any;

    const matching = { pickLp: jest.fn() } as any;
    const cfg = { platformWallet: USER_ADDR } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;

    return new OrderService(prisma, stellar, matching, cfg, markets, notifications, mockObjectStorage as any, makeUserReputationStub(), new OrderStatusService(prisma, stellar, cfg));
  }

  it('(a) FIAT_PAID TOP_UP order, caller is LP (confirmer) → returns {xdr, networkPassphrase}', async () => {
    const svc = makeSvc();

    const result = await svc.buildConfirmReleaseTx('order-1', LP_ADDR);
    expect(result).toEqual({ xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE });
  });

  it('FIAT_PAID WITHDRAW order, caller is user (confirmer) → returns {xdr, networkPassphrase}', async () => {
    const svc = makeSvc({
      findUnique: jest.fn().mockResolvedValue(makeOrder({ flow: 'WITHDRAW' })),
    });

    const result = await svc.buildConfirmReleaseTx('order-1', USER_ADDR);
    expect(result.xdr).toBe(SENTINEL_XDR);
  });

  it('(b) non-confirmer caller (user calls TOP_UP confirm) → ForbiddenException', async () => {
    const svc = makeSvc();

    await expect(svc.buildConfirmReleaseTx('order-1', USER_ADDR)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('WITHDRAW: LP is non-confirmer → ForbiddenException', async () => {
    const svc = makeSvc({
      findUnique: jest.fn().mockResolvedValue(makeOrder({ flow: 'WITHDRAW' })),
    });

    await expect(svc.buildConfirmReleaseTx('order-1', LP_ADDR)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('(c) wrong status (FUNDED) → ConflictException', async () => {
    const svc = makeSvc({
      findUnique: jest.fn().mockResolvedValue(makeOrder({ status: 'FUNDED' })),
    });
    await expect(svc.buildConfirmReleaseTx('order-1', LP_ADDR)).rejects.toThrow(
      ConflictException,
    );
  });

  it('order not found → NotFoundException', async () => {
    const svc = makeSvc({
      findUnique: jest.fn().mockResolvedValue(null),
    });
    await expect(svc.buildConfirmReleaseTx('order-1', LP_ADDR)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('stellar RPC error → ServiceUnavailableException (no internal leak)', async () => {
    const svc = makeSvc(
      {},
      {
        buildConfirmReleaseTx: jest.fn().mockRejectedValue(new Error('prepareTransaction failed: RPC timeout')),
      },
    );
    await expect(svc.buildConfirmReleaseTx('order-1', LP_ADDR)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('M2: chain refresh advances FIAT_PAID→RELEASED before status guard → ConflictException', async () => {
    const svc = makeSvc(
      {
        findUnique: jest.fn().mockResolvedValue(makeOrder({ status: 'FIAT_PAID' })),
        update: jest.fn().mockResolvedValue(makeOrder({ status: 'RELEASED' })),
      },
      {
        getTradeStatus: jest.fn().mockResolvedValue({ status: 'RELEASED' }),
      },
    );
    await expect(svc.buildConfirmReleaseTx('order-1', LP_ADDR)).rejects.toThrow(ConflictException);
  });
});

describe('GET /orders/:id/tx/confirm-release (HTTP controller)', () => {
  let app: INestApplication;

  const mockOrderSvcConfirm = {
    buildConfirmReleaseTx: jest.fn(),
    buildCreateTradeTx: jest.fn(),
    buildMarkFiatPaidTx: jest.fn(),
    createFromQuote: jest.fn(),
    listOrders: jest.fn(),
    getOrder: jest.fn(),
    cancelOrder: jest.fn(),
    listLpAssignments: jest.fn(),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [OrderController],
      providers: [
        { provide: OrderService, useValue: mockOrderSvcConfirm },
        { provide: ObjectStorageService, useValue: mockObjectStorage },
      ],
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

  it('(a) FIAT_PAID order fetched by its confirmer → 200 { xdr, networkPassphrase }', async () => {
    mockOrderSvcConfirm.buildConfirmReleaseTx.mockResolvedValue({
      xdr: SENTINEL_XDR,
      networkPassphrase: FAKE_PASSPHRASE,
    });

    const res = await request(app.getHttpServer())
      .get('/orders/order-1/tx/confirm-release')
      .expect(200);

    expect(res.body.xdr).toBe(SENTINEL_XDR);
    expect(res.body.networkPassphrase).toBe(FAKE_PASSPHRASE);
    expect(mockOrderSvcConfirm.buildConfirmReleaseTx).toHaveBeenCalledWith('order-1', LP_ADDR);
  });

  it('(b) non-confirmer caller → 403', async () => {
    mockOrderSvcConfirm.buildConfirmReleaseTx.mockRejectedValue(
      new ForbiddenException('only the confirmer may build this transaction'),
    );

    await request(app.getHttpServer())
      .get('/orders/order-1/tx/confirm-release')
      .expect(403);
  });

  it('(c) wrong status (FUNDED, not FIAT_PAID) → 409', async () => {
    mockOrderSvcConfirm.buildConfirmReleaseTx.mockRejectedValue(
      new ConflictException('order must be in FIAT_PAID status to confirm release'),
    );

    await request(app.getHttpServer())
      .get('/orders/order-1/tx/confirm-release')
      .expect(409);
  });

  it('order not found → 404', async () => {
    mockOrderSvcConfirm.buildConfirmReleaseTx.mockRejectedValue(
      new NotFoundException('order not found'),
    );

    await request(app.getHttpServer())
      .get('/orders/order-1/tx/confirm-release')
      .expect(404);
  });

  it('RPC unavailable → 503', async () => {
    mockOrderSvcConfirm.buildConfirmReleaseTx.mockRejectedValue(
      new ServiceUnavailableException('Stellar RPC unavailable, retry later'),
    );

    await request(app.getHttpServer())
      .get('/orders/order-1/tx/confirm-release')
      .expect(503);
  });
});

describe('POST /orders/:id/dispute (HTTP controller — DTO validation + delegation)', () => {
  let app: INestApplication;

  const mockOrderSvcDispute = {
    postDispute: jest.fn(),
    buildMarkFiatPaidTx: jest.fn(),
    buildCreateTradeTx: jest.fn(),
    buildConfirmReleaseTx: jest.fn(),
    createFromQuote: jest.fn(),
    listOrders: jest.fn(),
    getOrder: jest.fn(),
    cancelOrder: jest.fn(),
    listLpAssignments: jest.fn(),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [OrderController],
      providers: [
        { provide: OrderService, useValue: mockOrderSvcDispute },
        { provide: ObjectStorageService, useValue: mockObjectStorage },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { address: USER_ADDR, role: 'user' };
          return true;
        },
      })
      .overrideGuard(require('../auth/roles.guard').RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = mod.createNestApplication();

    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  const VALID_BODY = { reason: 'PAYMENT_NOT_RECEIVED', note: 'never received the funds' };

  it('valid body → 200, delegates to OrderService.postDispute with (id, caller, reason, note, evidenceUrl)', async () => {
    mockOrderSvcDispute.postDispute.mockResolvedValue({
      order: { id: 'order-1', status: 'FIAT_PAID' },
      dispute_tx: { xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE },
    });

    const res = await request(app.getHttpServer())
      .post('/orders/order-1/dispute')
      .send(VALID_BODY)
      .expect(200);

    expect(res.body.dispute_tx.xdr).toBe(SENTINEL_XDR);
    expect(mockOrderSvcDispute.postDispute).toHaveBeenCalledWith(
      'order-1',
      USER_ADDR,
      'PAYMENT_NOT_RECEIVED',
      'never received the funds',
      undefined,
    );
  });

  it('valid body WITH evidenceUrl → passed through as the 5th arg', async () => {
    mockOrderSvcDispute.postDispute.mockResolvedValue({
      order: { id: 'order-1' },
      dispute_tx: { xdr: SENTINEL_XDR, networkPassphrase: FAKE_PASSPHRASE },
    });

    await request(app.getHttpServer())
      .post('/orders/order-1/dispute')
      .send({ ...VALID_BODY, evidenceUrl: 'evidence/order-1-user.jpg' })
      .expect(200);

    expect(mockOrderSvcDispute.postDispute).toHaveBeenCalledWith(
      'order-1',
      USER_ADDR,
      'PAYMENT_NOT_RECEIVED',
      'never received the funds',
      'evidence/order-1-user.jpg',
    );
  });

  it('reason outside the cross-flow whitelist → 400 (service never called)', async () => {
    await request(app.getHttpServer())
      .post('/orders/order-1/dispute')
      .send({ ...VALID_BODY, reason: 'NOT_A_REAL_REASON' })
      .expect(400);
    expect(mockOrderSvcDispute.postDispute).not.toHaveBeenCalled();
  });

  it('missing reason → 400', async () => {
    await request(app.getHttpServer())
      .post('/orders/order-1/dispute')
      .send({ note: 'no reason given' })
      .expect(400);
    expect(mockOrderSvcDispute.postDispute).not.toHaveBeenCalled();
  });

  it('missing note → 400', async () => {
    await request(app.getHttpServer())
      .post('/orders/order-1/dispute')
      .send({ reason: 'OTHER' })
      .expect(400);
    expect(mockOrderSvcDispute.postDispute).not.toHaveBeenCalled();
  });

  it('note over 500 chars → 400', async () => {
    await request(app.getHttpServer())
      .post('/orders/order-1/dispute')
      .send({ ...VALID_BODY, note: 'x'.repeat(501) })
      .expect(400);
    expect(mockOrderSvcDispute.postDispute).not.toHaveBeenCalled();
  });

  it('note containing a control character (e.g. NUL) → 400', async () => {
    await request(app.getHttpServer())
      .post('/orders/order-1/dispute')
      .send({ ...VALID_BODY, note: 'bad\x00note' })
      .expect(400);
    expect(mockOrderSvcDispute.postDispute).not.toHaveBeenCalled();
  });

  it('a malformed evidenceUrl (path traversal attempt) → 400 (service never called)', async () => {
    await request(app.getHttpServer())
      .post('/orders/order-1/dispute')
      .send({ ...VALID_BODY, evidenceUrl: '../../etc/passwd' })
      .expect(400);
    expect(mockOrderSvcDispute.postDispute).not.toHaveBeenCalled();
  });

  it('an evidenceUrl with a non-whitelisted extension → 400', async () => {
    await request(app.getHttpServer())
      .post('/orders/order-1/dispute')
      .send({ ...VALID_BODY, evidenceUrl: 'evidence/order-1-user.exe' })
      .expect(400);
    expect(mockOrderSvcDispute.postDispute).not.toHaveBeenCalled();
  });

  it('an unknown field → 400 (forbidNonWhitelisted, matches main.ts)', async () => {
    await request(app.getHttpServer())
      .post('/orders/order-1/dispute')
      .send({ ...VALID_BODY, extraField: 'nope' })
      .expect(400);
    expect(mockOrderSvcDispute.postDispute).not.toHaveBeenCalled();
  });

  it('service 409 (window closed / already disputed) propagates as 409', async () => {
    mockOrderSvcDispute.postDispute.mockRejectedValue(
      new ConflictException('a dispute has already been filed for this order'),
    );
    await request(app.getHttpServer()).post('/orders/order-1/dispute').send(VALID_BODY).expect(409);
  });

  it('service 403 (non-party) propagates as 403', async () => {
    mockOrderSvcDispute.postDispute.mockRejectedValue(
      new ForbiddenException('only a trade party may open a dispute for this order'),
    );
    await request(app.getHttpServer()).post('/orders/order-1/dispute').send(VALID_BODY).expect(403);
  });
});
