import { Test } from '@nestjs/testing';
import {
  ConflictException,
  ExecutionContext,
  Logger,
  RequestMethod,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Keypair } from '@stellar/stellar-sdk';
import request from 'supertest';

import { ProviderReceiptController } from './provider-receipt.controller';
import { providerReceiptMessage } from './provider-receipt-message';
import { AdminService } from './admin.service';
import { RolesGuard } from '../auth/roles.guard';
import { ALLOW_TOKEN_CLASSES, TokenClassInterceptor } from '../auth/token-class.interceptor';
import { ConsumedChallengeService } from '../auth/consumed-challenge.service';
import { AuthService } from '../auth/auth.service';
import { verifySep53 } from '../auth/sep53';
import { sep53Signature } from '../scripts/sep24-fixtures';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { TradeOnChain } from '../stellar/stellar-read.types';
import { AttestorService } from '../stellar/attestor.service';
import { AppConfigService } from '../config/app-config.service';
import { MarketsService } from '../market/markets.service';
import { UserReputationService } from '../reputation/user-reputation.service';
import { NotificationService } from '../notification/notification.service';
import { refundOpensAt } from '../order/dispute.util';
import { configureHttp } from '../http-setup';

const NOW = 1_790_000_000;
const ISO_NOW = new Date(NOW * 1000).toISOString();
const TTL = 97;
const CURRENT_ESCROW = 'CCURRENTESCROWFROMCONFIG';
const ORDER_ESCROW = 'CESCROWTHISORDERWASCREATEDON';
const HASH = 'b'.repeat(64);
const OPERATOR = 'GOPERATORWHORESCUESADEPOSIT';
const PROVIDER = Keypair.random();
const STRANGER = Keypair.random();
const DEPOSITOR = Keypair.random();

const NOT_FOUND = 'This order was not found.';
const NOT_THE_PROVIDER = 'Only the provider assigned to this order can confirm its payment.';
const STALE = 'Your signed statement reached lolipay outside the time allowed for it, so nothing was recorded. Try again, and approve the new request in your wallet straight away.';
const ALREADY_USED = 'This signed statement was already used once, so this attempt recorded nothing. Try again to sign a new one.';
const CHAIN_UNREACHABLE = 'The network could not be reached to check this order, so the payment was not recorded. Try again in a moment.';
const ESCROW_NOT_FOUND = 'This order\'s escrow was not found on the network, so the payment was not recorded.';
const NOT_FUNDED_BY_CALLER = 'The escrow for this order was not funded from your wallet, so you cannot confirm its payment.';
const WINDOW_CLOSED = 'The time to confirm this payment has passed, so it can no longer be confirmed, and the USDC can be returned to you.';
const SERVER_ERROR = 'Confirming this payment ran into an error. Try again: a payment is never recorded on chain twice, so if the first attempt did go through, the release continues from there.';
const notSignedBy = (caller: string) =>
  `This signed statement could not be verified as signed by ${caller.slice(0, 4)}…${caller.slice(-4)}, the account you are logged in with, so nothing was recorded. Make sure your wallet is using that account, then try again.`;
const alreadyOnChain = (status: string) => `On the network this order is already ${status}, so there is nothing to confirm. Refresh the order.`;
const BEING_CONFIRMED = 'This order is already being confirmed. Wait a moment, then refresh it.';
const ONLY_A_DEPOSIT = 'Only a deposit\'s payment can be confirmed this way. On a withdrawal, the provider sends the rupiah and marks it paid from their own wallet.';
const notFundedInLolipayRecords = (status: string) =>
  `This order is ${status} in lolipay's records, and only a FUNDED deposit can be confirmed as paid. Refresh it: the records can lag behind the network.`;
const ATTESTOR_WINDOW_REFUSAL = 'The time to confirm this payment has passed, so it can no longer be confirmed, and nothing was sent to the network.';
const forbidden = (message: string) => ({ statusCode: 403, error: 'Forbidden', message });
const notFound = (message: string) => ({ statusCode: 404, error: 'Not Found', message });
const conflict = (message: string) => ({ statusCode: 409, error: 'Conflict', message });

type Selection = Record<string, unknown>;

interface OrderRow {
  id: string;
  tradeId: string;
  contractId: string | null;
  userAddress: string;
  flow: 'TOP_UP' | 'WITHDRAW';
  status: string;
  fiatAmount: bigint;
  fiatCurrency: string;
  ref: string | null;
  payDeadline: bigint;
  confirmDeadline: bigint;
  userClaimedPaidAt: Date | null;
  lpId: string | null;
  lp: { id: string; stellarAddress: string; status: string } | null;
  [field: string]: unknown;
}

interface Session {
  role?: string;
  cls?: string;
}

let serial = 0;

function orderRow(over: Partial<OrderRow> = {}): OrderRow {
  serial += 1;
  const n = serial.toString(16).padStart(12, '0');
  return {
    id: `3b2f6c1e-8a47-4d19-9c0e-${n}`,
    tradeId: `${'7'.repeat(52)}${n}`,
    contractId: ORDER_ESCROW,
    userAddress: DEPOSITOR.publicKey(),
    personId: 'person-of-the-depositor',
    lpId: 'lp-of-the-provider',
    flow: 'TOP_UP',
    rail: 'BANK',
    usdcAmount: 100_000_000n,
    fiatAmount: 1_500_000n,
    fiatCurrency: 'IDR',
    rateSnapshot: '15000',
    platformFeeBps: 30,
    lpFeeBps: 120,
    spreadBps: 0,
    platformWallet: 'GPLATFORMWALLET',
    lpWallet: PROVIDER.publicKey(),
    paymentMethodId: null,
    lpPaymentDetails: null,
    lpPaymentLabel: null,
    userPaymentDetails: null,
    status: 'FUNDED',
    payDeadline: BigInt(NOW + 600),
    confirmDeadline: BigInt(NOW + 1800),
    disputeDeadline: BigInt(NOW + 3600),
    createdAt: new Date((NOW - 60) * 1000),
    expiresAt: new Date((NOW + 600) * 1000),
    ref: 'LP-7K2Q',
    proofUrl: null,
    proofUploadedAt: null,
    proofRrn: null,
    proofAmount: null,
    proofPaidAt: null,
    userClaimedPaidAt: null,
    settledAt: null,
    settledStatus: null,
    eventPos: 0n,
    settlementTxHash: null,
    postSettleDeadline: null,
    resolverDisputed: false,
    onChainDisputedBy: null,
    slashDeadline: null,
    liabilityEstablished: false,
    disputeBy: null,
    disputeReason: null,
    disputeNote: null,
    disputeEvidenceUrl: null,
    disputeAt: null,
    disputeClosedAt: null,
    resolution: null,
    disputeLossAccrued: false,
    lp: { id: 'lp-of-the-provider', stellarAddress: PROVIDER.publicKey(), status: 'APPROVED' },
    ...over,
  };
}

function topUpOnChain(row: OrderRow, over: Partial<TradeOnChain> = {}): TradeOnChain {
  return {
    status: 'FUNDED',
    settledAt: 0,
    flow: 0,
    usdcProvider: PROVIDER.publicKey(),
    usdcRecipient: row.userAddress,
    confirmer: PROVIDER.publicKey(),
    ...over,
  };
}

function withdrawalOnChain(): TradeOnChain {
  return {
    status: 'FUNDED',
    settledAt: 0,
    flow: 1,
    usdcProvider: DEPOSITOR.publicKey(),
    usdcRecipient: PROVIDER.publicKey(),
    confirmer: DEPOSITOR.publicKey(),
  };
}

function matches(record: Record<string, unknown>, where: Selection = {}): boolean {
  return Object.entries(where).every(([field, wanted]) => {
    if (wanted !== null && typeof wanted === 'object') {
      throw new Error(`the fake store cannot evaluate where.${field}; extend the fake rather than loosen the test`);
    }
    return record[field] === wanted;
  });
}

function pick(source: Record<string, unknown>, select: Selection): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, how] of Object.entries(select)) {
    if (!how) continue;
    const value = source[field];
    const nested = typeof how === 'object' ? (how as { select?: Selection }).select : undefined;
    out[field] =
      nested && value !== null && typeof value === 'object' ? pick(value as Record<string, unknown>, nested) : value;
  }
  return out;
}

function project(row: OrderRow, args: { select?: Selection; include?: Selection }): Record<string, unknown> {
  if (args.select) return pick(row, args.select);
  const { lp, ...scalars } = row;
  const out: Record<string, unknown> = { ...scalars };
  const includeLp = args.include?.lp;
  if (includeLp) {
    const nested = typeof includeLp === 'object' ? (includeLp as { select?: Selection }).select : undefined;
    out.lp = lp && nested ? pick(lp, nested) : lp;
  }
  return out;
}

function headersFor(who: Keypair, session: Session = {}): Record<string, string> {
  return {
    'x-test-address': who.publicKey(),
    'x-test-role': session.role ?? 'lp',
    'x-test-cls': session.cls ?? 'session',
  };
}

function sessionFromHeaders(ctx: ExecutionContext): boolean {
  const req = ctx.switchToHttp().getRequest();
  const address = req.headers['x-test-address'];
  if (!address) {
    throw new UnauthorizedException();
  }
  req.user = { address, role: req.headers['x-test-role'], cls: req.headers['x-test-cls'] };
  return true;
}

function signedBy(key: Keypair, row: OrderRow, at: number): { at: number; signature: string } {
  return { at, signature: sep53Signature(key, providerReceiptMessage(row, at)) };
}

function freezeClockAt(secs: number): void {
  jest.useFakeTimers({
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
    now: secs * 1000,
  });
}

async function boot() {
  const rows = new Map<string, OrderRow>();
  const chain = new Map<string, TradeOnChain | Error>();
  const spent = new Set<string>();

  const findOrder = async (args: { where: Selection; select?: Selection; include?: Selection }) => {
    const row = [...rows.values()].find((candidate) => matches(candidate, args.where));
    return row ? project(row, args) : null;
  };

  const prisma = {
    order: {
      findUnique: jest.fn(findOrder),
      findFirst: jest.fn(findOrder),
      updateMany: jest.fn(async (args: { where: Selection; data: Selection }) => {
        let count = 0;
        for (const row of rows.values()) {
          if (matches(row, args.where)) {
            Object.assign(row, args.data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    lp: {
      findUnique: jest.fn(async (args: { where: Selection; select?: Selection }) => {
        const lp = [...rows.values()].map((row) => row.lp).find((candidate) => candidate !== null && matches(candidate, args.where));
        if (!lp) return null;
        return args.select ? pick(lp, args.select) : lp;
      }),
    },
    adminAudit: { create: jest.fn(async (_args: { data: Record<string, any> }) => ({})) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (work: (tx: typeof prisma) => unknown) => work(prisma));

  const stellar = {
    getTradeStatusStrict: jest.fn(async (contractId: string, tradeId: string): Promise<TradeOnChain | null> => {
      const found = chain.get(`${contractId}:${tradeId}`);
      if (found instanceof Error) throw found;
      return found ?? null;
    }),
  };
  const attestor = {
    attest: jest.fn(
      async (_contractId: string, _tradeId: string, _notAfterSecs: number): Promise<{ status: string; hash: string }> => ({
        status: 'SUCCESS',
        hash: HASH,
      }),
    ),
  };
  const consumed = {
    consume: jest.fn(async (nonce: string, _expiresAt: Date) => {
      if (spent.has(nonce)) return false;
      spent.add(nonce);
      return true;
    }),
  };
  const notifications = { notifyOrderStatus: jest.fn(async () => undefined) };
  const cfg = { escrowContractId: CURRENT_ESCROW, challengeTtl: TTL, corsOrigins: [] as string[] };

  const mod = await Test.createTestingModule({
    controllers: [ProviderReceiptController],
    providers: [
      AdminService,
      RolesGuard,
      { provide: APP_INTERCEPTOR, useClass: TokenClassInterceptor },
      { provide: PrismaService, useValue: prisma },
      { provide: StellarReadService, useValue: stellar },
      { provide: AppConfigService, useValue: cfg },
      { provide: MarketsService, useValue: {} },
      { provide: UserReputationService, useValue: {} },
      { provide: AttestorService, useValue: attestor },
      { provide: NotificationService, useValue: notifications },
      { provide: ConsumedChallengeService, useValue: consumed },
    ],
  })
    .overrideGuard(AuthGuard('jwt'))
    .useValue({ canActivate: sessionFromHeaders })
    .compile();

  const app = mod.createNestApplication();
  configureHttp(app);
  await app.init();

  const put = (row: OrderRow, onChain?: TradeOnChain | Error): OrderRow => {
    rows.set(row.id, { ...row });
    if (onChain) chain.set(`${row.contractId ?? CURRENT_ESCROW}:${row.tradeId}`, onChain);
    return row;
  };

  return {
    app,
    admin: mod.get(AdminService),
    prisma,
    stellar,
    attestor,
    consumed,
    put,
    fundedTopUp(rowOver: Partial<OrderRow> = {}, chainOver: Partial<TradeOnChain> = {}): OrderRow {
      const row = orderRow(rowOver);
      return put(row, topUpOnChain(row, chainOver));
    },
    get(row: OrderRow, who: Keypair = PROVIDER, session: Session = {}) {
      return request(app.getHttpServer()).get(`/orders/${row.id}/confirm-receipt`).set(headersFor(who, session));
    },
    post(row: OrderRow, body: object, who: Keypair = PROVIDER, session: Session = {}) {
      return request(app.getHttpServer())
        .post(`/orders/${row.id}/confirm-receipt`)
        .set(headersFor(who, session))
        .send(body);
    },
    auditRows(action?: string): Record<string, any>[] {
      return prisma.adminAudit.create.mock.calls
        .map(([args]) => args.data)
        .filter((data) => action === undefined || data.action === action);
    },
    orderReads(): number {
      return prisma.order.findUnique.mock.calls.length + prisma.order.findFirst.mock.calls.length;
    },
  };
}

type Stage = Awaited<ReturnType<typeof boot>>;

async function operatorAttestationInFlight(stage: Stage, row: OrderRow): Promise<() => Promise<void>> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const before = stage.attestor.attest.mock.calls.length;
  stage.attestor.attest.mockImplementationOnce(async () => {
    await gate;
    return { status: 'SUCCESS', hash: HASH };
  });
  const settled = stage.admin.attestFiatPaid(row.id, OPERATOR, 'BCA 12345').then(
    () => undefined,
    () => undefined,
  );
  for (let i = 0; i < 200 && stage.attestor.attest.mock.calls.length === before; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(stage.attestor.attest).toHaveBeenCalledTimes(before + 1);
  return async () => {
    open();
    await settled;
  };
}

async function operatorSentence(stage: Stage, row: OrderRow): Promise<string> {
  try {
    await stage.admin.attestFiatPaid(row.id, OPERATOR, 'BCA 12345');
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`the operator's attestation of ${row.id} was expected to be refused`);
}

describe('the provider confirms the rupiah arrived: GET and POST /orders/:id/confirm-receipt', () => {
  let stage: Stage;

  beforeEach(async () => {
    freezeClockAt(NOW);
    stage = await boot();
  });

  afterEach(async () => {
    await stage.app.close();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('runs at a configured signature lifetime other than the 120 s default, so a lifetime written into the code as a literal cannot pass the boundary tests below', () => {
    expect(TTL).not.toBe(120);
  });

  it('stands in for the order table with a store that honours select, so a loader that leaves out a field the signed message prints goes red here and not in production', async () => {
    const row = stage.fundedTopUp({ ref: 'LP-7K2Q' });

    const narrow = await stage.prisma.order.findUnique({
      where: { id: row.id },
      select: { id: true, tradeId: true, fiatAmount: true, fiatCurrency: true, lp: { select: { stellarAddress: true } } },
    });

    expect(narrow).toEqual({
      id: row.id,
      tradeId: row.tradeId,
      fiatAmount: row.fiatAmount,
      fiatCurrency: 'IDR',
      lp: { stellarAddress: PROVIDER.publicKey() },
    });
    expect(narrow).not.toHaveProperty('ref');
  });

  describe('the two routes and their guards', () => {
    it('declares exactly GET and POST on /orders/:id/confirm-receipt, each open to user, lp and admin and opted in to no extra token class', () => {
      const routes = Object.getOwnPropertyNames(ProviderReceiptController.prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => (ProviderReceiptController.prototype as unknown as Record<string, object>)[name])
        .filter((handler) => Reflect.getMetadata(METHOD_METADATA, handler) !== undefined);

      expect(Reflect.getMetadata(PATH_METADATA, ProviderReceiptController)).toBe('orders');
      expect(
        routes
          .map((handler) => `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)]} ${String(Reflect.getMetadata(PATH_METADATA, handler)).replace(/^\//, '')}`)
          .sort(),
      ).toEqual(['GET :id/confirm-receipt', 'POST :id/confirm-receipt']);
      for (const handler of routes) {
        expect(Reflect.getMetadata('roles', handler) ?? Reflect.getMetadata('roles', ProviderReceiptController)).toEqual(['user', 'lp', 'admin']);
        expect(Reflect.getMetadata(ALLOW_TOKEN_CLASSES, handler)).toBeUndefined();
      }
    });

    it('refuses a request with no session 401 on both routes, before the order is read', async () => {
      const row = stage.fundedTopUp();
      await request(stage.app.getHttpServer()).get(`/orders/${row.id}/confirm-receipt`).expect(401);
      await request(stage.app.getHttpServer())
        .post(`/orders/${row.id}/confirm-receipt`)
        .send(signedBy(PROVIDER, row, NOW))
        .expect(401);
      expect(stage.orderReads()).toBe(0);
    });

    it.each(['user', 'lp', 'admin'])(
      'admits the order\'s provider on both routes whatever role the session resolved to (%s) — an admitted request is the only proof the jwt guard sits on the route',
      async (role) => {
        const row = stage.fundedTopUp();
        const served = (await stage.get(row, PROVIDER, { role }).expect(200)).body as { message: string; at: number };
        await stage
          .post(row, { at: served.at, signature: sep53Signature(PROVIDER, served.message) }, PROVIDER, { role })
          .expect(200);
        expect(stage.attestor.attest).toHaveBeenCalledTimes(1);
      },
    );

    it('refuses a session whose role is none of user, lp or admin 403 on both routes, before the order is read', async () => {
      const row = stage.fundedTopUp();
      await stage.get(row, PROVIDER, { role: 'resolver' }).expect(403);
      await stage.post(row, signedBy(PROVIDER, row, NOW), PROVIDER, { role: 'resolver' }).expect(403);
      expect(stage.orderReads()).toBe(0);
    });

    it('refuses a SEP-10 token 403 on both routes, before the order is read, because neither route opts in to that token class', async () => {
      const row = stage.fundedTopUp();
      await stage.get(row, PROVIDER, { role: 'user', cls: 'sep10' }).expect(403);
      await stage.post(row, signedBy(PROVIDER, row, NOW), PROVIDER, { role: 'user', cls: 'sep10' }).expect(403);
      expect(stage.orderReads()).toBe(0);
      expect(stage.consumed.consume).not.toHaveBeenCalled();
    });

    it('refuses an id that is not a UUID 400 on both routes, before the order is read', async () => {
      const notAnId = orderRow({ id: 'not-a-uuid' });
      await stage.get(notAnId).expect(400);
      await stage.post(notAnId, signedBy(PROVIDER, notAnId, NOW)).expect(400);
      expect(stage.orderReads()).toBe(0);
    });

    const MALFORMED_BODIES: [string, (proof: { at: number; signature: string }) => object][] = [
      ['that carries any field besides at and signature', (proof) => ({ ...proof, orderId: '3b2f6c1e-8a47-4d19-9c0e-000000000000' })],
      ['whose at is not an integer', (proof) => ({ ...proof, at: proof.at + 0.5 })],
      ['whose at is a string', (proof) => ({ ...proof, at: String(proof.at) })],
      ['whose signature is longer than 256 characters', (proof) => ({ ...proof, signature: 'A'.repeat(257) })],
      ['with no signature', (proof) => ({ at: proof.at })],
      ['with no at', (proof) => ({ signature: proof.signature })],
    ];

    it.each(MALFORMED_BODIES)('refuses a POST body %s with 400, before the order is read', async (_label, malformed) => {
      const row = stage.fundedTopUp();
      await stage.post(row, malformed(signedBy(PROVIDER, row, NOW))).expect(400);
      expect(stage.orderReads()).toBe(0);
      expect(stage.consumed.consume).not.toHaveBeenCalled();
    });
  });

  describe('GET — the server builds the bytes, the client only signs them', () => {
    it('G1 — gives the order\'s provider the exact bytes to sign and the Unix second they were issued, and locks, reads from the chain, spends and writes nothing', async () => {
      const row = stage.fundedTopUp({ ref: 'LP-7K2Q' });

      const res = await stage.get(row).expect(200);

      expect(res.body).toEqual({ message: providerReceiptMessage(row, NOW), at: NOW });
      expect(stage.stellar.getTradeStatusStrict).not.toHaveBeenCalled();
      expect(stage.consumed.consume).not.toHaveBeenCalled();
      expect(stage.prisma.adminAudit.create).not.toHaveBeenCalled();
      expect(stage.prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('G1 — still serves the provider while an operator attestation holds the order, because the GET takes no lock', async () => {
      const row = stage.fundedTopUp();
      const finish = await operatorAttestationInFlight(stage, row);

      const res = await stage.get(row).expect(200);
      await finish();

      expect(res.body).toEqual({ message: providerReceiptMessage(row, NOW), at: NOW });
    });

    it('G1 — serves an order whose row already reads FIAT_PAID, because the GET checks neither flow nor status and leaves that to the POST', async () => {
      const row = stage.fundedTopUp({ status: 'FIAT_PAID' });

      const res = await stage.get(row).expect(200);

      expect(res.body).toEqual({ message: providerReceiptMessage(row, NOW), at: NOW });
    });

    it('G2 — refuses a caller who is not the order\'s provider with a ForbiddenException carrying the step-2 sentence and nothing of the order, even while an operator attestation holds the order', async () => {
      const row = stage.fundedTopUp();
      const finish = await operatorAttestationInFlight(stage, row);

      const res = await stage.get(row, STRANGER).expect(403);
      await finish();

      expect(res.body).toEqual(forbidden(NOT_THE_PROVIDER));
      expect(stage.stellar.getTradeStatusStrict).not.toHaveBeenCalled();
      expect(stage.consumed.consume).not.toHaveBeenCalled();
    });

    it('G2 — refuses an order that does not exist with a NotFoundException carrying the step-1 sentence, reading nothing from the chain and spending nothing', async () => {
      const res = await stage.get(orderRow()).expect(404);

      expect(res.body).toEqual(notFound(NOT_FOUND));
      expect(stage.stellar.getTradeStatusStrict).not.toHaveBeenCalled();
      expect(stage.consumed.consume).not.toHaveBeenCalled();
      expect(stage.prisma.adminAudit.create).not.toHaveBeenCalled();
    });
  });

  describe('POST — the signature, its freshness and its single use', () => {
    it('S1 — admits the provider who signs exactly what the GET served: the attestation row names the provider and carries the served message, the signature and when it was received, and it verifies against the provider\'s key', async () => {
      const row = stage.fundedTopUp({ ref: 'LP-7K2Q' });
      const served = (await stage.get(row).expect(200)).body as { message: string; at: number };
      expect(served.message).toBe(providerReceiptMessage(row, served.at));
      const signature = sep53Signature(PROVIDER, served.message);

      await stage.post(row, { at: served.at, signature }).expect(200);

      const attempts = stage.auditRows('order.attestFiatPaid');
      expect(attempts).toHaveLength(1);
      expect(attempts[0].actorAddress).toBe(PROVIDER.publicKey());
      expect(attempts[0].after.evidence).toEqual({ message: served.message, signature, receivedAt: ISO_NOW });
      expect(
        verifySep53(attempts[0].actorAddress, attempts[0].after.evidence.message, attempts[0].after.evidence.signature),
      ).toBe(true);
    });

    it('S2 — refuses a signature by any other key over the right message with a ForbiddenException carrying the step-4 sentence and the caller\'s short address, before the single-use record, the lock and the chain, even while an operator attestation holds the order', async () => {
      const row = stage.fundedTopUp();
      const finish = await operatorAttestationInFlight(stage, row);

      const res = await stage.post(row, signedBy(STRANGER, row, NOW)).expect(403);
      await finish();

      expect(res.body).toEqual(forbidden(notSignedBy(PROVIDER.publicKey())));
      expect(stage.consumed.consume).not.toHaveBeenCalled();
      expect(stage.stellar.getTradeStatusStrict).not.toHaveBeenCalled();
    });

    const S3_VARIANTS: [string, string, Partial<OrderRow>][] = [
      ['S3a', 'a different amount', { fiatAmount: 1_500_001n }],
      ['S3b', 'a different reference', { ref: 'LP-9XW3' }],
      ['S3c', 'another order\'s id and trade id', { id: '3b2f6c1e-8a47-4d19-9c0e-ffffffffffff', tradeId: 'f'.repeat(64) }],
    ];

    it.each(S3_VARIANTS)(
      '%s — refuses the provider\'s own signature over this order\'s message with %s with a ForbiddenException carrying the step-4 sentence, because the POST rebuilds the message from its own row',
      async (_id, _label, variant) => {
        const row = stage.fundedTopUp();

        const res = await stage.post(row, signedBy(PROVIDER, { ...row, ...variant }, NOW)).expect(403);

        expect(res.body).toEqual(forbidden(notSignedBy(PROVIDER.publicKey())));
        expect(stage.consumed.consume).not.toHaveBeenCalled();
        expect(stage.attestor.attest).not.toHaveBeenCalled();
      },
    );

    it('S4 — admits a signature issued exactly the configured lifetime ago', async () => {
      const row = stage.fundedTopUp();

      await stage.post(row, signedBy(PROVIDER, row, NOW - TTL)).expect(200);

      expect(stage.attestor.attest).toHaveBeenCalledTimes(1);
    });

    const OUTSIDE_THE_LIFETIME: [string, number][] = [
      ['one second older than the configured lifetime', NOW - TTL - 1],
      ['dated one second in the future', NOW + 1],
    ];

    it.each(OUTSIDE_THE_LIFETIME)('S4 — refuses a signature %s with a ForbiddenException carrying the step-3 sentence, before anything is spent or read from the chain', async (_label, at) => {
      const row = stage.fundedTopUp();

      const res = await stage.post(row, signedBy(PROVIDER, row, at)).expect(403);

      expect(res.body).toEqual(forbidden(STALE));
      expect(stage.consumed.consume).not.toHaveBeenCalled();
      expect(stage.stellar.getTradeStatusStrict).not.toHaveBeenCalled();
      expect(stage.attestor.attest).not.toHaveBeenCalled();
    });

    it('S5 — refuses the same proof a second time with a ForbiddenException carrying the step-5 sentence, with no second chain read or attestation, and the single-use key is the order and the issued second, kept one second past the last instant the proof could pass', async () => {
      const row = stage.fundedTopUp();
      const proof = signedBy(PROVIDER, row, NOW);

      await stage.post(row, proof).expect(200);
      const second = await stage.post(row, proof).expect(403);

      expect(second.body).toEqual(forbidden(ALREADY_USED));
      expect(stage.stellar.getTradeStatusStrict).toHaveBeenCalledTimes(1);
      expect(stage.attestor.attest).toHaveBeenCalledTimes(1);
      expect(stage.consumed.consume.mock.calls).toEqual([
        [`confirm-receipt:${row.id}:${NOW}`, new Date((NOW + TTL + 1) * 1000)],
        [`confirm-receipt:${row.id}:${NOW}`, new Date((NOW + TTL + 1) * 1000)],
      ]);
    });

    it('S5b — refuses the same signature re-encoded from base64 to hex, which still verifies, with a ForbiddenException carrying the step-5 sentence, because single use is keyed on the signed message and not on the signature string', async () => {
      const row = stage.fundedTopUp();
      const proof = signedBy(PROVIDER, row, NOW);
      const hex = Buffer.from(proof.signature, 'base64').toString('hex');
      expect(hex).not.toBe(proof.signature);
      expect(verifySep53(PROVIDER.publicKey(), providerReceiptMessage(row, NOW), hex)).toBe(true);

      await stage.post(row, proof).expect(200);
      const reencoded = await stage.post(row, { at: NOW, signature: hex }).expect(403);

      expect(reencoded.body).toEqual(forbidden(ALREADY_USED));
      expect(stage.attestor.attest).toHaveBeenCalledTimes(1);
      expect(stage.stellar.getTradeStatusStrict).toHaveBeenCalledTimes(1);
    });

    const REFUSED_BEFORE_THE_LOCK: [string, (row: OrderRow) => object, string][] = [
      [
        'a signature over a different message',
        () => ({ at: NOW, signature: sep53Signature(PROVIDER, `lolipay-auth:${PROVIDER.publicKey()}:n:1:m`) }),
        notSignedBy(PROVIDER.publicKey()),
      ],
      ['a signature issued before the configured lifetime', (row) => signedBy(PROVIDER, row, NOW - TTL - 1), STALE],
    ];

    it.each(REFUSED_BEFORE_THE_LOCK)(
      'S6 — refuses %s with a ForbiddenException, not a 409, while an operator attestation holds the order, because it is refused before the lock and spends nothing',
      async (_label, proofFor, sentence) => {
        const row = stage.fundedTopUp();
        const finish = await operatorAttestationInFlight(stage, row);

        const res = await stage.post(row, proofFor(row)).expect(403);
        await finish();

        expect(res.body).toEqual(forbidden(sentence));
        expect(stage.consumed.consume).not.toHaveBeenCalled();
        expect(stage.stellar.getTradeStatusStrict).not.toHaveBeenCalled();
      },
    );

    it('S8 — refuses a body whose second differs from the second that was signed, even when both are inside the lifetime, with a ForbiddenException carrying the step-4 sentence, and spends nothing', async () => {
      const row = stage.fundedTopUp();
      const signed = signedBy(PROVIDER, row, NOW);

      const res = await stage.post(row, { at: NOW - 1, signature: signed.signature }).expect(403);

      expect(res.body).toEqual(forbidden(notSignedBy(PROVIDER.publicKey())));
      expect(stage.consumed.consume).not.toHaveBeenCalled();
      expect(stage.attestor.attest).not.toHaveBeenCalled();
    });
  });

  describe('POST — who may confirm, and what the chain must say', () => {
    it('T1 — admits the provider on a funded top-up: one chain read and one attestation on the order\'s own escrow, bounded by its refund instant; the row moves to FIAT_PAID; the only audit row is the provider\'s attempt carrying the signed receipt', async () => {
      const row = stage.fundedTopUp();
      const proof = signedBy(PROVIDER, row, NOW);

      const res = await stage.post(row, proof).expect(200);

      expect(res.body).toEqual({ orderId: row.id, submission: 'SUCCESS', txHash: HASH });
      expect(stage.stellar.getTradeStatusStrict).toHaveBeenCalledTimes(1);
      expect(stage.stellar.getTradeStatusStrict).toHaveBeenCalledWith(ORDER_ESCROW, row.tradeId);
      expect(stage.attestor.attest).toHaveBeenCalledTimes(1);
      expect(stage.attestor.attest).toHaveBeenCalledWith(ORDER_ESCROW, row.tradeId, Number(refundOpensAt(row)));
      expect(stage.prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: row.id, status: 'FUNDED' },
        data: { status: 'FIAT_PAID' },
      });
      expect(stage.auditRows()).toEqual([
        {
          actorAddress: PROVIDER.publicKey(),
          action: 'order.attestFiatPaid',
          targetType: 'Order',
          targetId: row.id,
          before: { status: 'FUNDED', contractId: ORDER_ESCROW, tradeId: row.tradeId },
          after: {
            evidence: { message: providerReceiptMessage(row, NOW), signature: proof.signature, receivedAt: ISO_NOW },
            submission: 'SUCCESS',
            txHash: HASH,
          },
        },
      ]);
    });

    it('T2 — refuses a caller who is not the order\'s provider with a ForbiddenException carrying the step-2 sentence, before the lock, the chain and the single-use record, even while an operator attestation holds the order', async () => {
      const row = stage.fundedTopUp();
      const finish = await operatorAttestationInFlight(stage, row);

      const res = await stage.post(row, signedBy(STRANGER, row, NOW), STRANGER).expect(403);
      await finish();

      expect(res.body).toEqual(forbidden(NOT_THE_PROVIDER));
      expect(stage.consumed.consume).not.toHaveBeenCalled();
      expect(stage.stellar.getTradeStatusStrict).not.toHaveBeenCalled();
      expect(stage.attestor.attest).toHaveBeenCalledTimes(1);
      expect(stage.auditRows().filter((data) => data.actorAddress === STRANGER.publicKey())).toEqual([]);
    });

    it('refuses an order that does not exist with a NotFoundException carrying the step-1 sentence, having spent nothing and read nothing from the chain', async () => {
      const absent = orderRow();

      const res = await stage.post(absent, signedBy(PROVIDER, absent, NOW)).expect(404);

      expect(res.body).toEqual(notFound(NOT_FOUND));
      expect(stage.consumed.consume).not.toHaveBeenCalled();
      expect(stage.stellar.getTradeStatusStrict).not.toHaveBeenCalled();
    });

    it('T3 — refuses the database provider who is not the provider on chain with a ForbiddenException carrying the step-8 sentence, after one chain read, attesting and recording nothing', async () => {
      const row = orderRow();
      stage.put(row, topUpOnChain(row, { usdcProvider: STRANGER.publicKey(), confirmer: STRANGER.publicKey() }));

      const res = await stage.post(row, signedBy(PROVIDER, row, NOW)).expect(403);

      expect(res.body).toEqual(forbidden(NOT_FUNDED_BY_CALLER));
      expect(stage.stellar.getTradeStatusStrict).toHaveBeenCalledTimes(1);
      expect(stage.attestor.attest).not.toHaveBeenCalled();
      expect(stage.auditRows()).toEqual([]);
    });

    it('checks the chain\'s provider before the already-recorded branch: on a trade the chain records as FiatPaid, a caller who is not its provider on chain gets the step-8 ForbiddenException and no receipt row is written', async () => {
      const row = orderRow();
      stage.put(
        row,
        topUpOnChain(row, { status: 'FIAT_PAID', usdcProvider: STRANGER.publicKey(), confirmer: STRANGER.publicKey() }),
      );

      const res = await stage.post(row, signedBy(PROVIDER, row, NOW)).expect(403);

      expect(res.body).toEqual(forbidden(NOT_FUNDED_BY_CALLER));
      expect(stage.auditRows()).toEqual([]);
    });

    it('T4a — refuses the provider on a withdrawal, where the chain records them as the one who receives the USDC, with the step-8 ForbiddenException, after exactly one chain read and with nothing attested', async () => {
      const row = orderRow({ flow: 'WITHDRAW', ref: null });
      stage.put(row, withdrawalOnChain());

      const res = await stage.post(row, signedBy(PROVIDER, row, NOW)).expect(403);

      expect(res.body).toEqual(forbidden(NOT_FUNDED_BY_CALLER));
      expect(stage.stellar.getTradeStatusStrict).toHaveBeenCalledTimes(1);
      expect(stage.attestor.attest).not.toHaveBeenCalled();
    });

    it('T4b — refuses the withdrawing user, who funded that escrow on chain but is not the order\'s provider, with the step-2 ForbiddenException, without reading the chain or spending anything', async () => {
      const row = orderRow({ flow: 'WITHDRAW', ref: null });
      stage.put(row, withdrawalOnChain());

      const res = await stage.post(row, signedBy(DEPOSITOR, row, NOW), DEPOSITOR, { role: 'user' }).expect(403);

      expect(res.body).toEqual(forbidden(NOT_THE_PROVIDER));
      expect(stage.stellar.getTradeStatusStrict).not.toHaveBeenCalled();
      expect(stage.consumed.consume).not.toHaveBeenCalled();
      expect(stage.attestor.attest).not.toHaveBeenCalled();
    });

    it('T4c — refuses with a 400 carrying the provider\'s withdrawal sentence an order the database records as a withdrawal, even when the caller is both its database provider and its provider on chain, attesting nothing', async () => {
      const row = orderRow({ flow: 'WITHDRAW', ref: null });
      stage.put(row, topUpOnChain(row));

      const res = await stage.post(row, signedBy(PROVIDER, row, NOW)).expect(400);

      expect(res.body).toMatchObject({ statusCode: 400, message: ONLY_A_DEPOSIT });
      expect(stage.attestor.attest).not.toHaveBeenCalled();
    });

    it('T5 — answers 200 alreadyRecorded with no attestation when the chain already records FiatPaid, and writes exactly one row, under its own action, carrying the signed receipt', async () => {
      const row = orderRow();
      stage.put(row, topUpOnChain(row, { status: 'FIAT_PAID' }));
      const proof = signedBy(PROVIDER, row, NOW);

      const res = await stage.post(row, proof).expect(200);

      expect(res.body).toEqual({ orderId: row.id, alreadyRecorded: true });
      expect(stage.attestor.attest).not.toHaveBeenCalled();
      expect(stage.auditRows()).toEqual([
        {
          actorAddress: PROVIDER.publicKey(),
          action: 'order.providerConfirmedReceipt',
          targetType: 'Order',
          targetId: row.id,
          before: { status: 'FUNDED', contractId: ORDER_ESCROW, tradeId: row.tradeId },
          after: {
            evidence: { message: providerReceiptMessage(row, NOW), signature: proof.signature, receivedAt: ISO_NOW },
            alreadyRecorded: true,
          },
        },
      ]);
    });

    it('T5b — still answers 200 alreadyRecorded when that receipt row cannot be written, and logs the failure against the order', async () => {
      const row = orderRow();
      stage.put(row, topUpOnChain(row, { status: 'FIAT_PAID' }));
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      stage.prisma.adminAudit.create.mockRejectedValueOnce(new Error('database blip'));

      const res = await stage.post(row, signedBy(PROVIDER, row, NOW)).expect(200);

      expect(res.body).toEqual({ orderId: row.id, alreadyRecorded: true });
      expect(logged.mock.calls.some(([message]) => String(message).includes(row.id))).toBe(true);
    });

    it('answers alreadyRecorded for a trade the chain records as FiatPaid even one second past the refund instant, because the already-recorded branch comes before the window check', async () => {
      const row = orderRow();
      stage.put(row, topUpOnChain(row, { status: 'FIAT_PAID' }));
      const late = Number(refundOpensAt(row)) + 1;
      jest.setSystemTime(late * 1000);

      const res = await stage.post(row, signedBy(PROVIDER, row, late)).expect(200);

      expect(res.body).toEqual({ orderId: row.id, alreadyRecorded: true });
    });

    it.each(['RELEASED', 'REFUNDED', 'DISPUTED'] as const)(
      'T6 — refuses a trade the chain records as %s, while the database row still reads FUNDED, with the step-10 ConflictException naming that status, attesting nothing and leaving the row alone',
      async (onChain) => {
        const row = orderRow();
        stage.put(row, topUpOnChain(row, { status: onChain }));

        const res = await stage.post(row, signedBy(PROVIDER, row, NOW)).expect(409);

        expect(res.body).toEqual(conflict(alreadyOnChain(onChain)));
        expect(stage.attestor.attest).not.toHaveBeenCalled();
        expect(stage.prisma.order.updateMany).not.toHaveBeenCalled();
      },
    );

    it('T7 — admits a confirmation at exactly the refund instant, mirroring the contract\'s strict comparison', async () => {
      const row = stage.fundedTopUp();
      const edge = Number(refundOpensAt(row));
      jest.setSystemTime(edge * 1000);

      await stage.post(row, signedBy(PROVIDER, row, edge)).expect(200);

      expect(stage.attestor.attest).toHaveBeenCalledTimes(1);
    });

    it('T7 — refuses a confirmation one second past the refund instant with the step-11 ConflictException and attests nothing', async () => {
      const row = stage.fundedTopUp();
      const late = Number(refundOpensAt(row)) + 1;
      jest.setSystemTime(late * 1000);

      const res = await stage.post(row, signedBy(PROVIDER, row, late)).expect(409);

      expect(res.body).toEqual(conflict(WINDOW_CLOSED));
      expect(stage.attestor.attest).not.toHaveBeenCalled();
    });

    it('T8 — answers a chain read that throws with the step-7 ConflictException that says to try again, attesting and writing nothing, and a chain that has no such trade with the other step-7 sentence', async () => {
      const unreachable = orderRow();
      stage.put(unreachable, new Error('rpc unreachable'));
      const unknown = orderRow();
      stage.put(unknown);

      const threw = await stage.post(unreachable, signedBy(PROVIDER, unreachable, NOW)).expect(409);
      const missing = await stage.post(unknown, signedBy(PROVIDER, unknown, NOW)).expect(409);

      expect(threw.body).toEqual(conflict(CHAIN_UNREACHABLE));
      expect(missing.body).toEqual(conflict(ESCROW_NOT_FOUND));
      expect(stage.attestor.attest).not.toHaveBeenCalled();
      expect(stage.prisma.order.updateMany).not.toHaveBeenCalled();
      expect(stage.auditRows()).toEqual([]);
    });

    it('T9 — never weighs the depositor\'s claim: the same order with and without a claim is attested alike', async () => {
      const unclaimed = stage.fundedTopUp({ userClaimedPaidAt: null });
      const claimed = stage.fundedTopUp({ userClaimedPaidAt: new Date((NOW - 30) * 1000) });

      const first = await stage.post(unclaimed, signedBy(PROVIDER, unclaimed, NOW));
      const second = await stage.post(claimed, signedBy(PROVIDER, claimed, NOW));

      expect([first.status, second.status]).toEqual([200, 200]);
      expect([first.body.submission, second.body.submission]).toEqual(['SUCCESS', 'SUCCESS']);
      expect(stage.attestor.attest.mock.calls.map((call) => call[2])).toEqual([
        Number(refundOpensAt(unclaimed)),
        Number(refundOpensAt(claimed)),
      ]);
    });

    it('T10 — refuses a valid proof with the step-6 ConflictException while an operator attestation holds the order, before any chain read, and the proof is spent', async () => {
      const row = stage.fundedTopUp();
      const finish = await operatorAttestationInFlight(stage, row);

      const res = await stage.post(row, signedBy(PROVIDER, row, NOW)).expect(409);

      expect(res.body).toEqual(conflict(BEING_CONFIRMED));
      expect(stage.stellar.getTradeStatusStrict).not.toHaveBeenCalled();
      expect(stage.consumed.consume.mock.calls).toEqual([
        [`confirm-receipt:${row.id}:${NOW}`, new Date((NOW + TTL + 1) * 1000)],
      ]);
      expect(stage.attestor.attest).toHaveBeenCalledTimes(1);
      await finish();
    });

    const REFUSED_AFTER_THE_LOCK: [
      string,
      (row: OrderRow) => TradeOnChain | Error,
      { statusCode: number; error: string; message: string },
    ][] = [
      [
        'refused at the chain-provider step',
        (row) => topUpOnChain(row, { usdcProvider: STRANGER.publicKey(), confirmer: STRANGER.publicKey() }),
        forbidden(NOT_FUNDED_BY_CALLER),
      ],
      ['refused because the chain read threw', () => new Error('rpc unreachable'), conflict(CHAIN_UNREACHABLE)],
    ];

    it.each(REFUSED_AFTER_THE_LOCK)(
      'T11 — releases the order after the provider is %s, so the operator\'s attestation right after is not refused as in flight',
      async (_label, onChain, refusal) => {
        const row = orderRow();
        stage.put(row, onChain(row));

        const res = await stage.post(row, signedBy(PROVIDER, row, NOW)).expect(refusal.statusCode);
        expect(res.body).toEqual(refusal);

        await expect(stage.admin.attestFiatPaid(row.id, OPERATOR, 'BCA 12345')).resolves.toMatchObject({
          submission: 'SUCCESS',
        });
      },
    );
  });

  describe('POST — what a provider reads when the attestation itself fails', () => {
    it('gives the provider the one 5xx sentence with the core\'s own status — 500 for an attestor error, 502 for a chain refusal, 503 for a missing key — carrying none of the raw error and no transaction hash, while the audit row keeps the raw error', async () => {
      const marker = 'rpc-internal-detail-7f3a9c';
      const failedHash = 'c'.repeat(64);
      const thrown = stage.fundedTopUp();
      const failed = stage.fundedTopUp();
      const unconfigured = stage.fundedTopUp();
      stage.attestor.attest
        .mockRejectedValueOnce(new Error(`simulation exploded ${marker}`))
        .mockResolvedValueOnce({ status: 'FAILED', hash: failedHash })
        .mockRejectedValueOnce(new ServiceUnavailableException(`no attestor key is configured ${marker}`));

      const replies: request.Response[] = [];
      for (const row of [thrown, failed, unconfigured]) {
        replies.push(await stage.post(row, signedBy(PROVIDER, row, NOW)));
      }

      for (const reply of replies) {
        expect(JSON.stringify(reply.body)).not.toContain(marker);
        expect(JSON.stringify(reply.body)).not.toContain(failedHash);
      }
      expect(replies.map((reply) => reply.status)).toEqual([500, 502, 503]);
      expect(replies[0].body).toMatchObject({ statusCode: 500, message: SERVER_ERROR });
      expect(replies[1].body).toMatchObject({ statusCode: 502, message: SERVER_ERROR });
      expect(replies[2].body).toMatchObject({ statusCode: 503, message: SERVER_ERROR });
      const attempt = stage.auditRows('order.attestFiatPaid').find((data) => data.targetId === thrown.id);
      expect(attempt?.after.error).toContain(marker);
    });

    it('gives the provider a 4xx the core raises with its own status and its own provider sentence — the withdrawal 400, and the 409 naming the status in lolipay\'s records — never the operator\'s words and never the 5xx sentence', async () => {
      const withdrawal = orderRow({ flow: 'WITHDRAW', ref: null });
      stage.put(withdrawal, topUpOnChain(withdrawal));
      const lagging = orderRow({ status: 'EXPIRED' });
      stage.put(lagging, topUpOnChain(lagging));
      const broken = stage.fundedTopUp();
      stage.attestor.attest.mockRejectedValueOnce(new Error('simulation exploded'));

      const serverError = await stage.post(broken, signedBy(PROVIDER, broken, NOW));
      const operatorOnWithdrawal = await operatorSentence(stage, withdrawal);
      const operatorOnLagging = await operatorSentence(stage, lagging);
      const providerOnWithdrawal = await stage.post(withdrawal, signedBy(PROVIDER, withdrawal, NOW)).expect(400);
      const providerOnLagging = await stage.post(lagging, signedBy(PROVIDER, lagging, NOW)).expect(409);

      expect(serverError.status).toBe(500);
      expect(providerOnWithdrawal.body).toMatchObject({ statusCode: 400, message: ONLY_A_DEPOSIT });
      expect(providerOnLagging.body).toEqual(conflict(notFundedInLolipayRecords('EXPIRED')));
      expect(providerOnWithdrawal.body.message).not.toBe(operatorOnWithdrawal);
      expect(providerOnWithdrawal.body.message).not.toBe(serverError.body.message);
      expect(providerOnLagging.body.message).not.toBe(operatorOnLagging);
      expect(providerOnLagging.body.message).not.toBe(serverError.body.message);
      expect(providerOnWithdrawal.body.message).not.toBe(providerOnLagging.body.message);
    });

    it('gives the provider the step-11 sentence when the attestor itself refuses because the window closed while the attestation waited its turn: one condition, one sentence, and the attestor\'s own words stay in the audit row', async () => {
      const row = stage.fundedTopUp();
      stage.attestor.attest.mockRejectedValueOnce(new ConflictException(ATTESTOR_WINDOW_REFUSAL));

      const res = await stage.post(row, signedBy(PROVIDER, row, NOW)).expect(409);

      expect(res.body).toEqual(conflict(WINDOW_CLOSED));
      expect(stage.attestor.attest).toHaveBeenCalledTimes(1);
      expect(stage.auditRows('order.attestFiatPaid').map((data) => data.after.error)).toEqual([ATTESTOR_WINDOW_REFUSAL]);
    });
  });
});

describe('S7 — the login verifier cannot be fed a receipt signature', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refuses the provider\'s signature over a v1 receipt message as a malformed challenge, before it spends a nonce or proves the wallet', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const consumed = { consume: jest.fn(async () => true) };
    const people = { proveWallet: jest.fn(async () => undefined) };
    const auth = new AuthService(
      {} as never,
      { challengeTtl: TTL, adminAddresses: [] } as never,
      {} as never,
      people as never,
      consumed as never,
    );
    const message = providerReceiptMessage(orderRow(), NOW);

    const refused = auth.verify(PROVIDER.publicKey(), message, sep53Signature(PROVIDER, message));

    await expect(refused).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(refused).rejects.toThrow('malformed challenge');
    expect(consumed.consume).not.toHaveBeenCalled();
    expect(people.proveWallet).not.toHaveBeenCalled();
  });
});
