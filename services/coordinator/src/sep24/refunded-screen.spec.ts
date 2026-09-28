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

const CLAIMED_AT = new Date(1_800_000_000_000);
const CLAIMED_TIME_TAG = '<time datetime="2027-01-15T08:00:00.000Z">15 January 2027 at 15:00 WIB</time>';
const TX_HASH = 'a'.repeat(64);

function refundedDeposit(overrides: Record<string, unknown> = {}) {
  const order = {
    id: 'order-1',
    status: 'REFUNDED',
    personId: 'person-1',
    tradeId: 'a'.repeat(64),
    contractId: 'CESCROW',
    flow: 'TOP_UP',
    userAddress: 'GUSER',
    lpWallet: 'GLP',
    usdcAmount: 111700000n,
    fiatAmount: 200000n,
    fiatCurrency: 'IDR',
    platformFeeBps: 30,
    lpFeeBps: 120,
    payDeadline: 1n,
    confirmDeadline: 2n,
    ref: 'LP-REF',
    settlementTxHash: TX_HASH,
    userClaimedPaidAt: null,
    lp: { stellarAddress: 'GLP' },
    ...overrides,
  };
  const row = { id: 'tx-1', orderId: 'order-1', stellarAccount: 'GUSER', personId: 'person-1', flow: 'TOP_UP', order };
  const accepted = { customerRef: 'GUSER', personId: 'person-1', status: 'ACCEPTED', screenedAt: new Date(), deliveredAt: new Date() };
  const prisma: any = {
    sep24Transaction: { findUnique: async () => row },
    order: { findUnique: async () => order },
    kycVerification: { findUnique: async () => accepted, findFirst: async (a: any) => (a?.where?.status === 'REJECTED' ? null : accepted) },
  };
  const orderStatusService: any = { refreshOrderStatus: async () => order };
  const people: any = { lookupPerson: async () => ({ id: 'person-1' }) };
  const service = new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, people, {} as any, orderStatusService, { isConfigured: false } as any);
  return service.renderInteractive('tx-1', mintInteractiveToken(cfg, 'tx-1', 'GUSER'));
}

const POINTER_PARAGRAPH =
  '<p>If you sent the rupiah, sign in with this same wallet at <a href="https://app.lolipay.app">app.lolipay.app</a>: the order appears there with its evidence, and it shows whether a dispute can still be opened and until when. That needs a wallet that can sign on Stellar — Freighter, or one that connects over WalletConnect.</p>';

const SETTLEMENT_PARAGRAPH = `<p>Refunded on Stellar: <a href="https://stellar.expert/explorer/testnet/tx/${TX_HASH}" target="_blank" rel="noopener">${TX_HASH}</a></p>`;

describe('the refunded screen a depositor who said they had paid sees', () => {
  it('names what the escrow did, never what the depositor lost, because a claim is not proof', async () => {
    const html = await refundedDeposit({ userClaimedPaidAt: CLAIMED_AT });
    expect(html).toContain('<h1>This deposit was refunded to the provider</h1>');
    expect(html).not.toContain('This deposit was not completed');
  });

  it('repeats the claim it holds, says no USDC was sent, and asks for the receipt', async () => {
    const html = await refundedDeposit({ userClaimedPaidAt: CLAIMED_AT });
    expect(html).toContain(
      `<p>You told us at <strong>${CLAIMED_TIME_TAG}</strong> that you had sent <strong>200.000</strong> IDR. It was not confirmed in time, so the escrow returned the USDC to the provider and this deposit is closed. <strong>No USDC was sent to you.</strong></p>`,
    );
    expect(html).toContain(
      '<p>If you did send that money, keep your transfer receipt. Keep the reference <strong>LP-REF</strong> and this transaction id: <strong>tx-1</strong>.</p>',
    );
  });

  it('links the refund on chain, points at the app for the dispute, and closes the deposit off', async () => {
    const html = await refundedDeposit({ userClaimedPaidAt: CLAIMED_AT });
    expect(html).toContain(SETTLEMENT_PARAGRAPH);
    expect(html).toContain(POINTER_PARAGRAPH);
    expect(html).toContain('<p>Do not send any more money for this deposit. Start a new one from your wallet when you are ready.</p>');
  });

  it('drops the reference clause rather than printing an empty one when the order carries no reference', async () => {
    const html = await refundedDeposit({ userClaimedPaidAt: CLAIMED_AT, ref: null });
    expect(html).toContain('<p>If you did send that money, keep your transfer receipt. Keep this transaction id: <strong>tx-1</strong>.</p>');
    expect(html).not.toContain('the reference');
  });

  it('is terminal: it neither refreshes itself nor shows the bare status word', async () => {
    const html = await refundedDeposit({ userClaimedPaidAt: CLAIMED_AT });
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain('Status: <strong>refunded');
    expect(html).not.toContain('<h1>Deposit status</h1>');
  });
});

describe('the refunded screen a depositor who never said they had paid sees', () => {
  it('says the deposit was not completed, and that this anchor took nothing', async () => {
    const html = await refundedDeposit();
    expect(html).toContain('<h1>This deposit was not completed</h1>');
    expect(html).toContain(
      '<p>No rupiah was confirmed for this deposit, so the escrow returned the USDC to the provider and it is closed. <strong>No USDC was sent to you, and nothing was taken from you by this anchor.</strong></p>',
    );
  });

  it('still asks for the receipt, because a transfer nobody confirmed may still have been sent', async () => {
    const html = await refundedDeposit();
    expect(html).toContain(
      '<p>If you did send the rupiah and it was simply never confirmed, keep your transfer receipt, the reference <strong>LP-REF</strong> and this transaction id: <strong>tx-1</strong>.</p>',
    );
  });

  it('links the refund on chain and points at the app with the same sentence the claimed screen uses', async () => {
    const html = await refundedDeposit();
    expect(html).toContain(SETTLEMENT_PARAGRAPH);
    expect(html).toContain(POINTER_PARAGRAPH);
  });

  it('invites a new deposit without warning against a second transfer, which it has no reason to suspect', async () => {
    const html = await refundedDeposit();
    expect(html).toContain('<p>Start a new deposit from your wallet when you are ready.</p>');
    expect(html).not.toContain('Do not send any more money for this deposit.');
  });

  it('drops the reference clause rather than printing an empty one when the order carries no reference', async () => {
    const html = await refundedDeposit({ ref: null });
    expect(html).toContain(
      '<p>If you did send the rupiah and it was simply never confirmed, keep your transfer receipt and this transaction id: <strong>tx-1</strong>.</p>',
    );
    expect(html).not.toContain('the reference');
  });

  it('is terminal: it neither refreshes itself nor shows the bare status word', async () => {
    const html = await refundedDeposit();
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain('Status: <strong>refunded');
    expect(html).not.toContain('<h1>Deposit status</h1>');
  });
});

describe('what a refunded deposit screen puts on the page cannot be turned into markup', () => {
  it('escapes the reference, which is provider-supplied text', async () => {
    const html = await refundedDeposit({ ref: '<script>x</script>' });
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x</script>');
  });

  it('omits the on-chain line entirely when no refund hash was recorded', async () => {
    const html = await refundedDeposit({ settlementTxHash: null });
    expect(html).not.toContain('Refunded on Stellar');
    expect(html).toContain('<h1>This deposit was not completed</h1>');
  });
});
