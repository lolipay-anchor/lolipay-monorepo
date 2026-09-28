import { ServiceUnavailableException } from '@nestjs/common';
import { Sep24Service } from './sep24.service';
import { mintInteractiveToken } from './interactive-token';
import { interactiveSentenceOf } from './interactive-sentence';

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

const NOW_SECS = Math.floor(Date.now() / 1000);

function setup(orderId: string | null = 'order-1', overrides: Record<string, unknown> = {}) {
  const order = orderId
    ? {
        id: orderId,
        status: 'FUNDED',
        personId: 'person-1',
        flow: 'TOP_UP',
        payDeadline: BigInt(NOW_SECS + 600),
        confirmDeadline: BigInt(NOW_SECS + 2400),
        userClaimedPaidAt: null,
        ...overrides,
      }
    : null;
  const row = { id: 'tx-1', orderId, stellarAccount: 'GUSER', personId: 'person-1', flow: 'TOP_UP', order };
  const tx = {
    order: { updateMany: jest.fn(), findUnique: jest.fn() },
    lp: { findUnique: jest.fn() },
    outboxMessage: { createMany: jest.fn() },
  };
  const accepted = { customerRef: 'GUSER', personId: 'person-1', status: 'ACCEPTED', screenedAt: new Date(), deliveredAt: new Date() };
  const prisma: any = {
    sep24Transaction: { findUnique: jest.fn(async () => row) },
    order: { findUnique: jest.fn(async () => order) },
    kycVerification: {
      findUnique: jest.fn(async () => accepted),
      findFirst: jest.fn(async (a: any) => (a?.where?.status === 'REJECTED' ? null : accepted)),
    },
    $transaction: jest.fn(async (cb: any) => cb(tx)),
  };
  const orderStatus: any = { refreshOrderStatus: jest.fn(async () => order) };
  const people: any = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) };
  const service = new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, people, {} as any, orderStatus, { isConfigured: false } as any);
  const token = mintInteractiveToken(cfg, 'tx-1', 'GUSER');
  return { service, prisma, tx, token, accepted };
}

function provider(tx: ReturnType<typeof setup>['tx']) {
  tx.order.updateMany.mockResolvedValue({ count: 1 });
  tx.order.findUnique.mockResolvedValue({
    lpId: 'lp-1', fiatAmount: 4_000_000n, fiatCurrency: 'IDR', ref: null,
    payDeadline: BigInt(NOW_SECS + 600), confirmDeadline: BigInt(NOW_SECS + 2400),
  });
  tx.lp.findUnique.mockResolvedValue({ alertEmail: 'lp@example.com' });
}

describe('claimPaid writes the conditional claim and asks the provider, ADR 0059 step 4 — the $transaction here is a fake that runs the callback and neither isolates nor rolls back, so the refusal cases below prove the throw leaves the callback with nothing enqueued, and cannot prove that Prisma discarded the claim row itself', () => {
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

  it('enqueues nothing when the conditional update matches no row, the race in which the order moved between the read and the write', async () => {
    const { service, tx, token } = setup('order-1');
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    await service.claimPaid('tx-1', token);
    expect(tx.order.findUnique).not.toHaveBeenCalled();
    expect(tx.outboxMessage.createMany).not.toHaveBeenCalled();
  });

  it('attempts no write at all on a second press, because a claim already on the order puts the reader on the confirmation screen rather than the instructions one', async () => {
    const { service, prisma, tx, token } = setup('order-1', { userClaimedPaidAt: new Date('2026-09-25T00:00:00.000Z') });
    await service.claimPaid('tx-1', token);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
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
  });

  it('tells the provider the escrow route can open rather than that it will run, and names no act as required of them, because an email is read hours after it is rendered and cannot re-render', async () => {
    const { service, tx, token } = setup('order-1');
    provider(tx);
    await service.claimPaid('tx-1', token);
    const text = tx.outboxMessage.createMany.mock.calls[0][0].data[0].payload.text as string;
    expect(text).toContain('Nothing has moved on chain, and there is no control for you on this order yet.');
    expect(text).toContain('the escrow can be returned to you from that time — the route is open on chain to anyone, including you — and the order closes.');
    expect(text).not.toMatch(/escrow returns/i);
    expect(text).not.toMatch(/nothing is required from you yet/i);
  });

  it('refuses the press with a sentence of its own when the matched provider has no alertEmail on file, rather than letting the filter offer a fresh deposit that cannot help', async () => {
    const { service, tx, token } = setup('order-1');
    provider(tx);
    tx.lp.findUnique.mockResolvedValue({ alertEmail: null });
    const thrown = await service.claimPaid('tx-1', token).then(() => null, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect((thrown as ServiceUnavailableException).getStatus()).toBe(503);
    const said = interactiveSentenceOf(thrown);
    expect(said).toContain('it has not recorded that you sent the rupiah');
    expect(said).toContain('nothing has been taken from you by this anchor');
    expect(said).toContain('do not send it a second time and do not start a new deposit');
    expect(said).not.toMatch(/try again|start a fresh one|dispute/i);
    expect(tx.order.updateMany).toHaveBeenCalled();
    expect(tx.outboxMessage.createMany).not.toHaveBeenCalled();
  });

  it('records nothing once the escrow refund window has opened, because every instant the claim would publish to the provider is then already in the past, ADR 0059 D3', async () => {
    const { service, prisma, tx, token } = setup('order-1', {
      payDeadline: BigInt(NOW_SECS - 10_000),
      confirmDeadline: BigInt(NOW_SECS - 8_200),
    });
    provider(tx);
    await service.claimPaid('tx-1', token);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(tx.outboxMessage.createMany).not.toHaveBeenCalled();
  });

  it('still records the claim on the last side of that instant, so the bound above is a bound on time and not a blanket refusal after the pay deadline', async () => {
    const { service, prisma, tx, token } = setup('order-1', {
      payDeadline: BigInt(NOW_SECS - 600),
      confirmDeadline: BigInt(NOW_SECS + 2_400),
    });
    provider(tx);
    await service.claimPaid('tx-1', token);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(tx.order.updateMany).toHaveBeenCalled();
    expect(tx.outboxMessage.createMany).toHaveBeenCalled();
  });

  it('records nothing when this identity was refused after the escrow was funded, the same screen gate the identity and amount posts already carry', async () => {
    const { service, prisma, tx, token, accepted } = setup('order-1');
    provider(tx);
    prisma.kycVerification.findFirst = jest.fn(async (a: any) =>
      a?.where?.status === 'REJECTED' ? { rejectionReason: 'the document could not be read' } : accepted,
    );
    await service.claimPaid('tx-1', token);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
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

  it('says what pressing it actually does, which is ask the provider to look, and never claims this anchor goes looking itself', async () => {
    const now = Math.floor(Date.now() / 1000);
    const html = await renderClaimable(BigInt(now - 100), BigInt(now + 10_000));
    expect(html).toContain('tell us now — it is what asks the provider to check their own account for it');
    expect(html).not.toMatch(/the only way we know/i);
  });

  it('offers no claim control once the refund window has itself opened, because only the anchor button before that instant means anything', async () => {
    const now = Math.floor(Date.now() / 1000);
    const html = await renderClaimable(BigInt(now - 10_000), BigInt(now - 10_000 + 3599));
    expect(html).toContain('The time to pay has passed');
    expect(html).not.toContain('Did you already send it?');
    expect(html).not.toContain('/paid"');
  });

  it('tells them to close the window once, in the control\'s own hint where there is a control and on its own where there is not', async () => {
    const now = Math.floor(Date.now() / 1000);
    const withControl = await renderClaimable(BigInt(now - 100), BigInt(now + 10_000));
    expect(withControl).toContain('Close this window and start a new deposit from your wallet.');
    expect(withControl).not.toContain('<p>You may close this window.</p>');

    const withoutControl = await renderClaimable(BigInt(now - 10_000), BigInt(now - 10_000 + 3599));
    expect(withoutControl).not.toContain('Close this window and start a new deposit from your wallet.');
    expect(withoutControl).toContain('<p>You may close this window.</p>');
  });
});

describe('the claim control before the pay deadline, ADR 0059 D3 slot 1A', () => {
  it('offers the control on the screen a depositor sees for the whole pay window, which nothing else asserts and which can therefore be deleted in silence', async () => {
    const now = Math.floor(Date.now() / 1000);
    const html = await renderClaimable(BigInt(now + 1_800), BigInt(now + 3_600));
    expect(html).toContain('Send your rupiah');
    expect(html).toContain('<h2>Already sent it?</h2>');
    expect(html).toContain('<button type="submit">I have sent the rupiah</button>');
    expect(html).toContain('action="/sep24/interactive/tx-1/paid"');
    expect(html).toContain('This does not move any USDC and it does not finish your deposit');
    expect(html).not.toContain('Did you already send it?');
  });
});
