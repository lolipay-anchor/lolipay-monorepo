import { validate } from 'jsonschema';
import { getTransactionSchema, transactionsSchema } from '@stellar/anchor-tests/lib/schemas/sep24';
import { serializeSep24, Sep24Record } from './sep24-transaction';

const ASSETS = { baseUrl: 'https://api.example', usdcIssuer: 'GISSUER' };
const ACCOUNT = 'GBCUZOOJ6W3BWPDW53QL3UDSXTGZNITUS32ZK7GE5ZQSLN7YUVOBHKJT';

function record(over: Partial<Sep24Record> = {}): Sep24Record {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    stellarAccount: ACCOUNT,
    startedAt: new Date('2026-09-01T00:00:00.000Z'),
    kycVerified: true,
    flow: 'TOP_UP',
    order: null,
    ...over,
  } as Sep24Record;
}

const order = {
  status: 'FUNDED' as const,
  usdcAmount: 1_000_0000000n,
  fiatAmount: 16_000_000n,
  fiatCurrency: 'IDR',
  platformFeeBps: 30,
  lpFeeBps: 0,
  settlementTxHash: null,
  settledAt: null,
  ref: null,
  payDeadline: 1_790_000_000n,
  confirmDeadline: 1_790_003_600n,
};

type SuiteStatus = 'incomplete' | 'pending_' | 'pending_user_transfer_start' | 'completed';

const settled = {
  ...{
    status: 'RELEASED' as const,
    usdcAmount: 1_000_0000000n,
    fiatAmount: 16_000_000n,
    fiatCurrency: 'IDR',
    platformFeeBps: 30,
    lpFeeBps: 0,
    ref: null,
    payDeadline: 1_790_000_000n,
    confirmDeadline: 1_790_003_600n,
  },
  settlementTxHash: 'a'.repeat(64),
  settledAt: new Date('2026-09-01T01:00:00.000Z'),
};

function conforms(json: any, kind: 'deposit' | 'withdrawal', status: SuiteStatus) {
  return validate({ transaction: json }, getTransactionSchema(kind, status));
}

describe('what we serialise satisfies the acceptance suite own schemas, not our idea of them', () => {
  it('a deposit at incomplete conforms', () => {
    const r = conforms(serializeSep24(record(), ASSETS), 'deposit', 'incomplete');
    expect(r.errors.map((e) => e.stack)).toEqual([]);
  });

  it('a withdrawal at incomplete conforms, which needs a non-null from', () => {
    const json = serializeSep24(record({ flow: 'WITHDRAW' }), ASSETS);
    expect(json.kind).toBe('withdrawal');
    expect(typeof json.from).toBe('string');
    expect(json.from).toBe(ACCOUNT);
    const r = conforms(json, 'withdrawal', 'incomplete');
    expect(r.errors.map((e) => e.stack)).toEqual([]);
  });

  it('one withdrawal row does not poison the list schema a deposit assertion relies on', () => {
    const list = {
      transactions: [
        serializeSep24(record(), ASSETS),
        serializeSep24(record({ id: '22222222-2222-4222-8222-222222222222', flow: 'WITHDRAW' }), ASSETS),
      ],
    };
    const r = validate(list, transactionsSchema);
    expect(r.errors.map((e) => e.stack)).toEqual([]);
  });

  it('a withdrawal waiting on the user, at MATCHED, still satisfies the list schema every deposit assertion relies on', () => {
    const list = {
      transactions: [serializeSep24(record({ flow: 'WITHDRAW', order: { ...order, status: 'MATCHED' as const } }), ASSETS)],
    };
    const r = validate(list, transactionsSchema);
    expect(r.errors.map((e) => e.stack)).toEqual([]);
    expect(list.transactions[0].status).toBe('pending_user');
  });

  it('never fabricates a from on a deposit, where it is genuinely unknown', () => {
    expect(serializeSep24(record(), ASSETS).from).toBeUndefined();
    expect(serializeSep24(record({ order }), ASSETS).from).toBeUndefined();
  });

  it('reports a withdrawal as paying USDC and receiving rupiah, not the reverse, and paying the gross rather than the net', () => {
    const dep = serializeSep24(record({ order }), ASSETS);
    expect(dep.amount_in_asset).toBe('iso4217:IDR');
    expect(dep.amount_out_asset).toBe(`stellar:USDC:${ASSETS.usdcIssuer}`);

    const wd = serializeSep24(record({ flow: 'WITHDRAW', order }), ASSETS);
    expect(wd.amount_in_asset).toBe(`stellar:USDC:${ASSETS.usdcIssuer}`);
    expect(wd.amount_out_asset).toBe('iso4217:IDR');
    expect(wd.amount_in).toBe('1000.0000000');
    expect(wd.amount_in).not.toBe(dep.amount_out);
    expect(wd.amount_out).toBe(dep.amount_in);
  });

  it('does not tell a wallet to send funds the user has already sent', () => {
    expect(serializeSep24(record({ order }), ASSETS).status).toBe('pending_user_transfer_start');
    expect(serializeSep24(record({ flow: 'WITHDRAW', order }), ASSETS).status).toBe('pending_anchor');
  });

  it("a funded deposit satisfies the vendor's pending_ required set", () => {
    const json = serializeSep24(record({ order }), ASSETS);
    const r = conforms(json, 'deposit', 'pending_');
    expect(r.errors.map((e) => e.stack)).toEqual([]);
  });

  it('a completed withdrawal conforms, which is where the suite demands the withdraw_* keys back', () => {
    const json = serializeSep24(record({ flow: 'WITHDRAW', order: settled }), ASSETS);
    expect(json.status).toBe('completed');
    const r = conforms(json, 'withdrawal', 'completed');
    expect(r.errors.map((e) => e.stack)).toEqual([]);
  });

  it('a completed deposit still conforms, so the withdrawal work did not cost the shipped direction', () => {
    const json = serializeSep24(record({ order: settled }), ASSETS);
    const r = conforms(json, 'deposit', 'completed');
    expect(r.errors.map((e) => e.stack)).toEqual([]);
  });

  it('the suite has no withdrawal schema for a pending_ status, which is why FUNDED maps elsewhere', () => {
    expect(() => conforms({}, 'withdrawal', 'pending_')).toThrow(/Unknown withdrawal/);
  });

  it('leaves the withdraw_* fields null, because a Soroban escrow is not a payable anchor account', () => {
    const wd = serializeSep24(record({ flow: 'WITHDRAW', order }), ASSETS);
    expect(wd.withdraw_anchor_account).toBeNull();
    expect(wd.withdraw_memo).toBeNull();
    expect(wd.withdraw_memo_type).toBeNull();
    expect(wd.to).toBeNull();
  });
});
