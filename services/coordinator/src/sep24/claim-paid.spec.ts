import { Sep24Service } from './sep24.service';
import { mintInteractiveToken } from './interactive-token';

const cfg = {
  anchorBaseUrl: 'https://api.lolipay.app',
  usdcAssetCode: 'USDC',
  usdcAssetIssuer: 'GISSUER',
  networkPassphrase: 'Test SDF Network ; September 2015',
  kycRequireAml: true,
  jwtSecret: ['unit', 'test', 'key', '0123456789'].join('-'),
  jwtIssuer: 'https://lolipay.app',
  jwtAudience: 'lolipay-app',
} as any;

function setup(orderId: string | null = 'order-1') {
  const row = { id: 'tx-1', orderId, stellarAccount: 'GUSER', personId: 'person-1', flow: 'TOP_UP', order: null };
  const tx = {
    order: { updateMany: jest.fn(), findUnique: jest.fn() },
    lp: { findUnique: jest.fn() },
    outboxMessage: { createMany: jest.fn() },
  };
  const prisma: any = {
    sep24Transaction: { findUnique: jest.fn(async () => row) },
    kycVerification: { findUnique: jest.fn(async () => null), findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (cb: any) => cb(tx)),
  };
  const people: any = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) };
  const service = new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, people, {} as any, {} as any, { isConfigured: false } as any);
  const token = mintInteractiveToken(cfg, 'tx-1', 'GUSER');
  return { service, tx, token };
}

describe('claimPaid writes the conditional claim and asks the provider, ADR 0059 step 4', () => {
  it('does nothing when the SEP-24 transaction carries no order yet', async () => {
    const { service, tx, token } = setup(null);
    await service.claimPaid('tx-1', token);
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it('conditions the write on the ORDER id, never on the route/transaction id, because the two are different strings that both compile', async () => {
    const { service, tx, token } = setup('order-1');
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.order.findUnique.mockResolvedValue({
      lpId: 'lp-1', fiatAmount: 4_000_000n, fiatCurrency: 'IDR', ref: null, payDeadline: 1n, confirmDeadline: 2n,
    });
    tx.lp.findUnique.mockResolvedValue({ alertEmail: 'lp@example.com' });
    await service.claimPaid('tx-1', token);
    const where = tx.order.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe('order-1');
    expect(where.id).not.toBe('tx-1');
    expect(where.flow).toBe('TOP_UP');
    expect(where.status).toBe('FUNDED');
    expect(where.userClaimedPaidAt).toBeNull();
  });

  it('enqueues nothing on a repeat press, where the conditional update matches no row', async () => {
    const { service, tx, token } = setup('order-1');
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    await service.claimPaid('tx-1', token);
    expect(tx.order.findUnique).not.toHaveBeenCalled();
    expect(tx.outboxMessage.createMany).not.toHaveBeenCalled();
  });

  it('reads the provider from a typed select and builds the outbox payload from that value, never from the loosely-typed interactive row', async () => {
    const { service, tx, token } = setup('order-1');
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.order.findUnique.mockResolvedValue({
      lpId: 'lp-typed', fiatAmount: 4_000_000n, fiatCurrency: 'IDR', ref: 'LP-42', payDeadline: 1n, confirmDeadline: 2n,
    });
    tx.lp.findUnique.mockResolvedValue({ alertEmail: 'lp@example.com' });
    await service.claimPaid('tx-1', token);
    expect(tx.lp.findUnique.mock.calls[0][0].where.id).toBe('lp-typed');
    const job = tx.outboxMessage.createMany.mock.calls[0][0].data[0];
    expect(job.kind).toBe('email');
    expect(job.payload.lpId).toBe('lp-typed');
    expect(job.payload.personId).toBeNull();
    expect(job.dedupeKey).toBe('email:order-1:USER_CLAIMED_PAID:lp-typed');
    expect(job.payload.text).not.toMatch(/confirm it on your dashboard/i);
  });

  it('refuses the press and enqueues nothing when the matched provider has no alertEmail on file', async () => {
    const { service, tx, token } = setup('order-1');
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.order.findUnique.mockResolvedValue({
      lpId: 'lp-1', fiatAmount: 4_000_000n, fiatCurrency: 'IDR', ref: null, payDeadline: 1n, confirmDeadline: 2n,
    });
    tx.lp.findUnique.mockResolvedValue({ alertEmail: null });
    await expect(service.claimPaid('tx-1', token)).rejects.toThrow();
    expect(tx.outboxMessage.createMany).not.toHaveBeenCalled();
  });

  it('refuses the press when the order carries no provider at all', async () => {
    const { service, tx, token } = setup('order-1');
    tx.order.updateMany.mockResolvedValue({ count: 1 });
    tx.order.findUnique.mockResolvedValue({
      lpId: null, fiatAmount: 4_000_000n, fiatCurrency: 'IDR', ref: null, payDeadline: 1n, confirmDeadline: 2n,
    });
    await expect(service.claimPaid('tx-1', token)).rejects.toThrow();
    expect(tx.lp.findUnique).not.toHaveBeenCalled();
    expect(tx.outboxMessage.createMany).not.toHaveBeenCalled();
  });
});

function renderClaimable(payDeadline: bigint, confirmDeadline: bigint) {
  const order = {
    id: 'order-1',
    status: 'FUNDED',
    personId: 'person-1',
    flow: 'TOP_UP',
    usdcAmount: 111700000n,
    fiatAmount: 200000n,
    fiatCurrency: 'IDR',
    platformFeeBps: 30,
    lpFeeBps: 120,
    payDeadline,
    confirmDeadline,
    ref: 'LP-42',
    lpPaymentLabel: 'BCA',
    lpPaymentDetails: '1231231231',
    rail: 'BANK',
    userClaimedPaidAt: null,
  };
  const row = {
    id: 'tx-1',
    orderId: 'order-1',
    stellarAccount: 'GUSER',
    personId: 'person-1',
    flow: 'TOP_UP',
    startedAt: new Date('2026-09-25T00:00:00.000Z'),
    order,
  };
  const accepted = { customerRef: 'GUSER', personId: 'person-1', status: 'ACCEPTED', screenedAt: new Date(), deliveredAt: new Date() };
  const prisma: any = {
    sep24Transaction: { findUnique: async () => row },
    order: { findUnique: async () => order },
    kycVerification: {
      findUnique: async () => accepted,
      findFirst: async (a: any) => (a?.where?.status === 'REJECTED' ? null : accepted),
      findMany: async () => [],
    },
  };
  const orderStatusService: any = { refreshOrderStatus: async () => order };
  const people: any = { lookupPerson: async () => ({ id: 'person-1' }) };
  const service = new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, people, {} as any, orderStatusService, { isConfigured: false } as any);
  return service.renderInteractive('tx-1', mintInteractiveToken(cfg, 'tx-1', 'GUSER'));
}

describe('the claim control after the pay deadline, ADR 0059 D3 slot 1B', () => {
  it('still lets the depositor claim once the pay deadline has passed but the refund window has not opened yet', async () => {
    const now = Math.floor(Date.now() / 1000);
    const html = await renderClaimable(BigInt(now - 100), BigInt(now + 10_000));
    expect(html).toContain('The time to pay has passed');
    expect(html).toContain('Did you already send it?');
    expect(html).toContain("action=\"/sep24/interactive/tx-1/paid\"");
  });

  it('offers no claim control once the refund window has itself opened, because only the anchor button before that instant means anything', async () => {
    const now = Math.floor(Date.now() / 1000);
    const html = await renderClaimable(BigInt(now - 10_000), BigInt(now - 10_000 + 3599));
    expect(html).toContain('The time to pay has passed');
    expect(html).not.toContain('Did you already send it?');
    expect(html).not.toContain('/paid"');
  });
});
