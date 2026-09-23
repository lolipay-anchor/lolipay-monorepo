import { OrderService } from './order.service';
import { withTxSupport, orderStatusFor, orderTxFor, verifiedCustomerStub, makeUserReputationStub } from './test-helpers';

const fakeStorage = {} as any;

const USER = 'GUSER';
const LP = 'GLP';
const PLATFORM = 'GPLATFORM';

describe('OrderService.createFromQuote snapshots the provider label onto the order it creates', () => {
  function makeSvc(pickLpOverrides: Partial<any> = {}) {
    const quote = {
      id: 'q1',
      userAddress: USER,
      flow: 'TOP_UP',
      rail: 'BANK',
      usdcAmount: 100_000_000n,
      fiatAmount: 1_600_000n,
      fiatCurrency: 'IDR',
      rateSnapshot: '16000',
      platformFeeBps: 30,
      lpFeeBps: 120,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const created: any[] = [];
    const prisma = {
      quote: {
        findUnique: jest.fn().mockResolvedValue(quote),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        create: jest.fn().mockImplementation(({ data }: any) => {
          const row = {
            id: `ord-${created.length + 1}`,
            tradeId: 't1',
            lpId: 'lp1',
            platformWallet: PLATFORM,
            lpWallet: LP,
            createdAt: new Date(),
            ...data,
          };
          created.push(row);
          return Promise.resolve(row);
        }),
      },
      config: {
        upsert: jest.fn().mockResolvedValue({
          id: 1,
          paused: false,
          minOrder: 1n,
          maxOrder: 10_000_000_000n,
          platformWallet: PLATFORM,
          payWindowSecs: 1800,
          confirmWindowSecs: 1800,
          disputeWindowSecs: 1800,
        }),
      },
    } as any;
    prisma.kycVerification = verifiedCustomerStub();
    withTxSupport(prisma);
    const stellar = {
      getStakeInfo: jest.fn().mockResolvedValue({ staked: '1000000000000', unbonding: '0', unbond_available_at: 0, min_stake: '1', eligible: true }),
      hasUsdcTrustline: jest.fn().mockResolvedValue(true),
    } as any;
    const matching = {
      pickLp: jest.fn().mockResolvedValue({
        id: 'lp1',
        stellarAddress: LP,
        paymentMethodId: 'pm1',
        details: 'BCA 123',
        label: 'BCA',
        staked: 1_000_000_000_000n,
        ...pickLpOverrides,
      }),
    } as any;
    const cfg = { platformWallet: PLATFORM } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: quote.fiatCurrency, enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new OrderService(prisma, stellar, matching, cfg, markets, notifications, fakeStorage, makeUserReputationStub(), orderStatusFor(prisma, stellar, cfg), orderTxFor(prisma, stellar, cfg));
    return { svc, prisma, created };
  }

  it('carries the picked payment method label onto the order row it writes', async () => {
    const { svc, prisma } = makeSvc({ label: 'BCA' });

    await svc.createFromQuote(USER, 'q1');

    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lpPaymentLabel: 'BCA' }) }),
    );
  });

  it('carries a different label unchanged, so the snapshot is not a hardcoded fixture', async () => {
    const { svc, prisma } = makeSvc({ label: 'Mandiri' });

    await svc.createFromQuote(USER, 'q1');

    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lpPaymentLabel: 'Mandiri' }) }),
    );
  });
});
