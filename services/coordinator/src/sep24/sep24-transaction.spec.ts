import { serializeSep24, Sep24Record } from './sep24-transaction';

const BASE = {
  baseUrl: 'https://api.lolipay.app',
  usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
};

const tx = (over: Partial<Sep24Record> = {}): Sep24Record => ({
  id: '7a1f0c9e-0000-4000-8000-000000000001',
  stellarAccount: 'GBKBPRR63VBOLS6MCWSC6ZRXVHBHYLEECZ627PH3LWJCRCI3LKWKJSWU',
  startedAt: new Date('2026-08-28T10:00:00.000Z'),
  kycVerified: false,
  flow: 'TOP_UP',
  order: null,
  ...over,
});

const order = (over: Record<string, unknown> = {}) => ({
  status: 'FUNDED',
  usdcAmount: 25_0000000n,
  fiatAmount: 4_000_000n,
  fiatCurrency: 'IDR',
  platformFeeBps: 50,
  lpFeeBps: 100,
  spreadBps: 0,
  settlementTxHash: null,
  settledAt: null,
  ref: null,
  ...over,
}) as any;

describe('a SEP-24 transaction as third-party wallet software reads it', () => {
  it('carries what every status requires, whatever the state', () => {
    const out = serializeSep24(tx(), BASE);
    for (const key of ['id', 'kind', 'status', 'more_info_url', 'started_at', 'to']) {
      expect(out).toHaveProperty(key);
    }
    expect(out.kind).toBe('deposit');
  });

  it('names the account it will pay, because the schema requires it at every status', () => {
    expect(serializeSep24(tx(), BASE).to).toBe(tx().stellarAccount);
  });

  it('writes started_at ending in Z, because the suite pastes it into a query string unencoded', () => {
    expect(serializeSep24(tx(), BASE).started_at).toBe('2026-08-28T10:00:00.000Z');
  });

  it('gives an absolute more_info_url, the one format the suite actually enforces', () => {
    expect(serializeSep24(tx(), BASE).more_info_url).toMatch(
      /^https:\/\/api\.lolipay\.app\/sep24\/more-info\//,
    );
  });

  it('reports kyc_verified so a wallet knows why it is still incomplete', () => {
    expect(serializeSep24(tx(), BASE).kyc_verified).toBe(false);
    expect(serializeSep24(tx({ kycVerified: true }), BASE).kyc_verified).toBe(true);
  });

  it('withholds the amount fields while incomplete, because no quote has produced them', () => {
    const out = serializeSep24(tx(), BASE);
    expect(out.status).toBe('incomplete');
    expect(out).not.toHaveProperty('amount_in');
  });

  it('carries all four amount fields the moment it reports any pending status', () => {
    const out = serializeSep24(tx({ order: order() }), BASE);
    expect(out.status).toBe('pending_user_transfer_start');
    expect(out.amount_in).toBe('4000000');
    expect(out.amount_in_asset).toBe('iso4217:IDR');
    expect(out.amount_out_asset).toMatch(/^stellar:USDC:G/);
  });

  it('promises only what the escrow will actually pay, after the fees it takes on chain', () => {
    const out = serializeSep24(tx({ order: order() }), BASE);
    expect(out.amount_out).toBe('24.6250000');
    expect(out.amount_out).not.toBe('25.0000000');
  });

  it('quotes the fee in the asset it is taken from, which is USDC and never rupiah', () => {
    const out = serializeSep24(tx({ order: order() }), BASE);
    expect(out.fee_details).toEqual({
      total: '0.3750000',
      asset: `stellar:USDC:${BASE.usdcIssuer}`,
    });
    expect(out).not.toHaveProperty('amount_fee');
  });

  it('adds up: what the user is promised plus the fee is the whole escrowed amount', () => {
    const out = serializeSep24(tx({ order: order() }), BASE);
    const asUnits = (v: string) => BigInt(v.replace('.', ''));
    expect(asUnits(out.amount_out!) + asUnits(out.fee_details!.total)).toBe(250000000n);
  });

  it('adds the settlement hash and completion time only once released', () => {
    const done = serializeSep24(
      tx({ order: order({ status: 'RELEASED', settlementTxHash: 'abc123', settledAt: new Date('2026-08-28T11:00:00.000Z') }) }),
      BASE,
    );
    expect(done.status).toBe('completed');
    expect(done.stellar_transaction_id).toBe('abc123');
    expect(done.completed_at).toBe('2026-08-28T11:00:00.000Z');
  });

  it('publishes the external reference it also lets a wallet search by', () => {
    const out = serializeSep24(tx({ order: order({ ref: 'LP-2026-0042' }) }), BASE);
    expect(out.external_transaction_id).toBe('LP-2026-0042');
  });

  it('omits the external reference rather than sending null when there is none', () => {
    const out = serializeSep24(tx({ order: order({ ref: null }) }), BASE);
    expect(out).not.toHaveProperty('external_transaction_id');
  });

  it('dates a refund too, because the spec asks for the time it reached refunded as well', () => {
    const out = serializeSep24(
      tx({ order: order({ status: 'REFUNDED', settledAt: new Date('2026-08-28T12:00:00.000Z') }) }),
      BASE,
    );
    expect(out.status).toBe('refunded');
    expect(out.completed_at).toBe('2026-08-28T12:00:00.000Z');
  });

  it('never ships the counterparty, the wallets or the dispute note to a third-party wallet', () => {
    const out = serializeSep24(
      tx({ order: order({ lpWallet: 'GLP', userPaymentDetails: 'bank 123', disputeNote: 'he lied' }) }),
      BASE,
    );
    const flat = JSON.stringify(out);
    expect(flat).not.toMatch(/GLP|bank 123|he lied|lpWallet|disputeNote/);
  });

  it('names the issuer its configuration names, so testnet and mainnet cannot be confused', () => {
    const out = serializeSep24(tx({ order: order() }), { ...BASE, usdcIssuer: 'GMAINNETISSUER' });
    expect(out.amount_out_asset).toBe('stellar:USDC:GMAINNETISSUER');
  });

  it('carries the settlement keys at completed even when the chain hash never arrived, because the acceptance suite requires them present', () => {
    const done = serializeSep24(
      tx({ order: order({ status: 'RELEASED', settlementTxHash: null, settledAt: null }) }),
      BASE,
    );

    expect(done.status).toBe('completed');
    expect(Object.keys(done)).toContain('stellar_transaction_id');
    expect(Object.keys(done)).toContain('completed_at');
    expect(done.stellar_transaction_id).toBeNull();
    expect(done.completed_at).toBeNull();
  });
});
