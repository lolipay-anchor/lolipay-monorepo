import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { StrKey } from '@stellar/stellar-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { Sep12Service } from '../kyc/sep12.service';
import { RateService } from '../rate/rate.service';
import { OrderService } from '../order/order.service';
import { AppConfigService } from '../config/app-config.service';
import { baseUnitsToUsdc } from '../money/money';
import { serializeSep24, Sep24Record, Sep24TransactionJson } from './sep24-transaction';
import { mintInteractiveToken, readInteractiveToken } from './interactive-token';
import { escapeHtml, formatFiat, interactiveScreen, page } from './interactive-page';
import { REQUIRED_KYC_FIELDS } from '../kyc/kyc-provider';
import { sep24Status } from './sep24-status';
import {
  SEP24_PAGE_DEFAULT,
  SEP24_PAGE_MAX,
  TransactionsQueryDto,
  TransactionQueryDto,
} from './sep24-query.dto';

const ORDER_FIELDS = {
  status: true,
  usdcAmount: true,
  fiatAmount: true,
  fiatCurrency: true,
  platformFeeBps: true,
  lpFeeBps: true,
  settlementTxHash: true,
  settledAt: true,
  personId: true,
  ref: true,
} as const;

@Injectable()
export class Sep24Service {
  private readonly log = new Logger('Sep24');

  constructor(
    private prisma: PrismaService,
    private cfg: AppConfigService,
    private sep12: Sep12Service,
    private rate: RateService,
    private orders: OrderService,
  ) {}

  private assets() {
    return { baseUrl: this.cfg.anchorBaseUrl, usdcIssuer: this.cfg.usdcAssetIssuer };
  }

  private assertAssetServed(assetCode: string | undefined): void {
    if (assetCode !== undefined && assetCode !== this.cfg.usdcAssetCode) {
      throw new BadRequestException(`this anchor does not serve ${assetCode}`);
    }
  }

  async info() {
    const config = await this.prisma.config.findFirst();
    const code = this.cfg.usdcAssetCode;
    return {
      deposit: {
        [code]: {
          enabled: true,
          min_amount: baseUnitsToUsdc(config?.minOrder ?? 0n),
          max_amount: baseUnitsToUsdc(config?.maxOrder ?? 0n),
          fee_percent: ((config?.platformFeeBps ?? 0) + (config?.lpFeeBps ?? 0)) / 100,
        },
      },
      withdraw: { [code]: { enabled: false } },
      fee: { enabled: false },
      features: { account_creation: false, claimable_balances: false },
    };
  }

  private async screenedPeople(personIds: string[]): Promise<Set<string>> {
    if (personIds.length === 0) return new Set();
    const rows = await this.prisma.kycVerification.findMany({
      where: { personId: { in: personIds }, status: 'ACCEPTED', screenedAt: { not: null } },
      select: { personId: true },
    });
    return new Set(rows.map((r) => r.personId));
  }

  private async dress(rows: any[]): Promise<Sep24TransactionJson[]> {
    const screened = await this.screenedPeople([...new Set(rows.map((r) => r.personId))]);
    return rows.map((row) =>
      serializeSep24(
        {
          id: row.id,
          stellarAccount: row.stellarAccount,
          startedAt: row.startedAt,
          kycVerified: screened.has(row.personId),
          order: row.order && row.order.personId === row.personId ? row.order : null,
        } as Sep24Record,
        this.assets(),
      ),
    );
  }

  async list(
    subject: string,
    query: TransactionsQueryDto,
  ) {
    this.assertAssetServed(query.asset_code);
    if (query.kind && query.kind !== 'deposit') return { transactions: [] };

    const since = query.no_older_than ? new Date(query.no_older_than) : undefined;
    if (since && Number.isNaN(since.getTime())) {
      throw new BadRequestException('no_older_than is not a readable time');
    }
    const take = Math.min(query.limit ?? SEP24_PAGE_DEFAULT, SEP24_PAGE_MAX);

    const rows = await this.prisma.sep24Transaction.findMany({
      where: {
        stellarAccount: subject,
        ...(since ? { startedAt: { gte: since } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take,
      include: { order: { select: ORDER_FIELDS } },
    });
    return { transactions: await this.dress(rows) };
  }

  async one(subject: string, query: TransactionQueryDto) {
    const where = query.id
      ? { id: query.id }
      : query.stellar_transaction_id
        ? { order: { settlementTxHash: query.stellar_transaction_id } }
        : query.external_transaction_id
          ? { order: { ref: query.external_transaction_id } }
          : null;
    if (!where) throw new BadRequestException('name a transaction by id, stellar_transaction_id or external_transaction_id');

    const row = await this.prisma.sep24Transaction.findFirst({
      where: { ...where, stellarAccount: subject },
      include: { order: { select: ORDER_FIELDS } },
    });
    if (!row) throw new NotFoundException('this anchor holds no such transaction for you');
    const [transaction] = await this.dress([row]);
    return { transaction };
  }

  async openInteractive(subject: string, personId: string, body: Record<string, unknown>) {
    const assetCode = body.asset_code;
    if (typeof assetCode !== 'string' || assetCode.length === 0) {
      throw new BadRequestException('asset_code is required');
    }
    if (assetCode !== this.cfg.usdcAssetCode) {
      throw new BadRequestException(`this anchor does not serve ${assetCode}`);
    }
    if (body.account !== undefined) {
      if (typeof body.account !== 'string' || body.account.length > 96) {
        throw new BadRequestException('account is not a Stellar address');
      }
      const named = body.account.split(':')[0];
      const known =
        StrKey.isValidEd25519PublicKey(named) ||
        StrKey.isValidMed25519PublicKey(named) ||
        StrKey.isValidContract(named);
      if (!known) {
        throw new BadRequestException('account is not a Stellar address');
      }
      if (body.account !== subject && named !== subject.split(':')[0]) {
        throw new BadRequestException(
          'this anchor credits the account its token speaks for, and will not deposit to another',
        );
      }
    }

    const row = await this.prisma.sep24Transaction.create({
      data: { personId, stellarAccount: subject, assetCode },
    });
    return {
      type: 'interactive_customer_info_needed',
      url: `${this.cfg.anchorBaseUrl}/sep24/interactive/${row.id}?token=${mintInteractiveToken(
        this.cfg,
        row.id,
        subject,
      )}`,
      id: row.id,
    };
  }

  async interactiveState(id: string, token: string) {
    const { account } = readInteractiveToken(this.cfg, token, id);
    const row = await this.prisma.sep24Transaction.findUnique({
      where: { id },
      include: {
        order: {
          select: { ...ORDER_FIELDS, id: true, lpPaymentDetails: true, expiresAt: true, payDeadline: true },
        },
      },
    });
    if (!row || row.stellarAccount !== account) {
      throw new NotFoundException('this anchor holds no such transaction');
    }
    const [kyc, screenedElsewhere, refusedAnywhere] = await Promise.all([
      this.prisma.kycVerification.findUnique({ where: { customerRef: row.stellarAccount } }),
      this.prisma.kycVerification.findFirst({
        where: { personId: row.personId, status: 'ACCEPTED', screenedAt: { not: null } },
        select: { customerRef: true },
      }),
      this.prisma.kycVerification.findFirst({
        where: { personId: row.personId, status: 'REJECTED' },
        select: { rejectionReason: true },
      }),
    ]);
    return { row, kyc, account, screenedElsewhere, refusedAnywhere };
  }

  interactiveUrl(id: string, token: string): string {
    return `${this.cfg.anchorBaseUrl}/sep24/interactive/${id}?token=${encodeURIComponent(token)}`;
  }

  private formAction(id: string, suffix: string): string {
    return `/sep24/interactive/${encodeURIComponent(id)}${suffix}`;
  }

  async assertReadable(id: string, token: string): Promise<void> {
    await this.interactiveState(id, token);
  }

  async renderInteractive(id: string, token: string): Promise<string> {
    const state = await this.interactiveState(id, token);
    const { row, kyc } = state;
    const screen = this.screenFor(row, kyc, state);
    const post = (suffix: string) => this.formAction(id, suffix);
    const carry = `<input type="hidden" name="token" value="${escapeHtml(token)}">`;

    if (screen === 'refused') {
      return page('Verification refused', `<p>${escapeHtml((state.refusedAnywhere as any)?.rejectionReason ?? kyc?.rejectionReason ?? 'This identity was refused.')}</p>`);
    }
    if (screen === 'identity') {
      const fields = REQUIRED_KYC_FIELDS.map(
        (f) => `<p><label>${escapeHtml(f.replace(/_/g, ' '))}<br><input name="${escapeHtml(f)}" required></label></p>`,
      ).join('');
      return page(
        'Verify your identity',
        `<form method="post" action="${escapeHtml(post('/identity'))}">${fields}${carry}<button type="submit">Continue</button></form>`,
      );
    }
    if (screen === 'waiting_on_identity') {
      const again = kyc?.verificationUrl
        ? `<p><a href="${escapeHtml(kyc.verificationUrl)}">Continue verification</a></p>`
        : '';
      return page(
        'Checking your identity',
        `<p>This usually takes a moment. This page refreshes itself.</p>${again}`,
        10,
      );
    }
    if (screen === 'amount') {
      return page(
        'How much would you like to deposit?',
        `<form method="post" action="${escapeHtml(post('/amount'))}"><p><label>Amount in IDR<br><input name="fiat_amount" inputmode="numeric" required></label></p>${carry}<button type="submit">Continue</button></form>`,
      );
    }
    if (screen === 'waiting_on_escrow') {
      return page('Preparing your deposit', '<p>A liquidity provider is locking the USDC in escrow. This page refreshes itself.</p>', 10);
    }
    if (screen === 'instructions') {
      const o = row.order as any;
      const due = o.payDeadline ? new Date(Number(o.payDeadline) * 1000).toISOString() : null;
      return page(
        'Send your rupiah',
        [
          `<p>Send <strong>${escapeHtml(formatFiat(o.fiatAmount))}</strong> ${escapeHtml(o.fiatCurrency)} to:</p>`,
          `<pre>${escapeHtml(o.lpPaymentDetails ?? 'your provider will be shown here')}</pre>`,
          `<p>Reference: <strong>${escapeHtml(o.ref ?? '')}</strong></p>`,
          due
            ? `<p><strong>Send it before ${escapeHtml(due)}.</strong> After that the escrow returns the USDC to the provider and your transfer cannot be matched.</p>`
            : '',
          '<p>You may close this window. Your wallet will show the deposit once it settles.</p>',
        ].join(''),
        30,
      );
    }
    return page('Deposit status', `<p>Status: <strong>${escapeHtml(sep24Status(row.order as any))}</strong></p>`);
  }

  async submitIdentity(id: string, token: string, fields: Record<string, string>) {
    const state = await this.interactiveState(id, token);
    const { row, kyc } = state;
    if (this.screenFor(row, kyc, state) !== 'identity') {
      throw new ForbiddenException('this deposit is not waiting for identity details');
    }
    await this.sep12.put(row.stellarAccount, fields);
    const after = await this.prisma.kycVerification.findUnique({
      where: { customerRef: row.stellarAccount },
    });
    return after?.verificationUrl ?? null;
  }

  private screenFor(row: any, kyc: any, state?: { screenedElsewhere?: unknown; refusedAnywhere?: unknown }) {
    if (state?.refusedAnywhere) {
      return interactiveScreen({ kycStatus: 'REJECTED', screened: false, orderStatus: null });
    }
    const screened = Boolean(state?.screenedElsewhere);
    return interactiveScreen({
      kycStatus: screened ? 'ACCEPTED' : (kyc?.status ?? null),
      screened,
      orderStatus: (row.order?.status as any) ?? null,
    });
  }

  verificationHandoff(url: string): string {
    return page(
      'Verify your identity',
      [
        `<p><a href="${escapeHtml(url)}">Continue to verification</a></p>`,
        '<p>Open the link above to finish verifying. You can return to this window afterwards.</p>',
      ].join(''),
    );
  }

  async submitAmount(id: string, token: string, rawAmount: unknown) {
    const state = await this.interactiveState(id, token);
    const { row, kyc } = state;
    if (row.orderId) return;
    if (this.screenFor(row, kyc, state) !== 'amount') {
      throw new ForbiddenException(
        'this deposit is not at the point of naming an amount; reopen the page to see where it is',
      );
    }

    const digits = String(rawAmount ?? '').replace(/[^0-9]/g, '');
    if (digits.length === 0 || digits.length > 18) {
      throw new BadRequestException('name an amount in rupiah');
    }
    const quote = await this.rate.createQuote(row.stellarAccount, 'TOP_UP', 'BANK', {
      fiatAmount: BigInt(digits),
    });
    const created = await this.orders.createFromQuote(row.stellarAccount, quote.id);
    const orderId = String((created.order as Record<string, unknown>).id);
    const linked = await this.prisma.sep24Transaction.updateMany({
      where: { id, orderId: null, stellarAccount: row.stellarAccount },
      data: { orderId },
    });
    if (linked.count !== 1) {
      const undone = await this.prisma.order.updateMany({
        where: { id: orderId, status: { in: ['CREATED', 'MATCHED'] } },
        data: { status: 'CANCELLED' },
      });
      this.log.warn(
        `a second deposit order was opened for SEP-24 transaction ${id} and has been cancelled (${undone.count} row) rather than left holding provider capacity`,
      );
      throw new ConflictException('this deposit was already opened');
    }
  }

  async moreInfo(id: string): Promise<string> {
    const row = await this.prisma.sep24Transaction.findUnique({
      where: { id },
      include: { order: { select: ORDER_FIELDS } },
    });
    if (!row) throw new NotFoundException('this anchor holds no such transaction');
    const [tx] = await this.dress([row]);
    return [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<title>lolipay deposit</title></head><body>',
      '<h1>lolipay deposit</h1>',
      `<p>Status: <strong>${tx.status}</strong></p>`,
      `<p>Started: ${tx.started_at}</p>`,
      '</body></html>',
    ].join('');
  }
}
